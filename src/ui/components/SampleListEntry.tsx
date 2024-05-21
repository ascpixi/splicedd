import { Chip, CircularProgress, Tooltip } from "@nextui-org/react";
import { SpliceSample } from "../../splice/api";
import { decodeSpliceAudio } from "../../splice/decoder";
import { ClockCircleLinearIcon, ClockSquareBoldIcon } from '@nextui-org/shared-icons'
import { MusicalNoteIcon } from "@heroicons/react/20/solid";
import { PlayIcon, StopIcon } from "@heroicons/react/20/solid";

import { Response, ResponseType, fetch } from '@tauri-apps/api/http';
import { useState } from "react";
import { SamplePlaybackContext } from "../playback";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import * as wav from "node-wav";
import { checkFileExists, createPlaceholder, writeSampleFile } from "../../native";
import { cfg } from "../../config";
import { path } from "@tauri-apps/api";

const getChordTypeDisplay = (type: string | null) =>
    type == null ? "" : type == "major" ? " Major" : " Minor";

/**
 * Provides a view describing a Splice sample.
 */
export default function SampleListEntry(
    {sample, ctx }: {
        sample: SpliceSample,
        ctx: SamplePlaybackContext
    }
) {
    const [fgLoading, setFgLoading] = useState(false);
    const [playing, setPlaying] = useState(false);
    const audio = document.createElement("audio");

    const pack = sample.parents.items[0];
    const packCover = pack
        ? pack.files.find(x => x.asset_file_type_slug == "cover_image")?.url
        : "img/missing-cover.png";

    let decodedSample: Uint8Array | null = null;

    let fetchAhead: Promise<Response<ArrayBuffer>> | null = null;
    function startFetching() {
        if (fetchAhead != null)
            return;

        const file = sample.files.find(x => x.asset_file_type_slug == "preview_mp3")!;

        fetchAhead = fetch<ArrayBuffer>(file.url, {
            method: "GET",
            responseType: ResponseType.Binary
        });
    }

    audio.onended = () => setPlaying(false);

    function stop() {
        audio.pause();
        audio.currentTime = 0;
        setPlaying(false);
    }

    async function handlePlayClick() {
        ctx.cancellation?.();

        if (playing) 
            return;

        if (audio.src == "") {
            setFgLoading(true);
            await ensureAudioDecoded();
            setFgLoading(false);

            audio.src = URL.createObjectURL(
                new Blob([decodedSample!], { "type": "audio/mpeg" })
            );
        }

        audio.play();
        setPlaying(true);

        ctx.setCancellation(() => stop);
    }

    async function ensureAudioDecoded() {
        if (decodedSample != null)
            return;

        if (fetchAhead == null) {
            startFetching();
        }

        const resp = await fetchAhead;
        decodedSample = decodeSpliceAudio(new Uint8Array(resp!.data));
    }

    async function handleDrag() {
        const samplePath = sample.name.replace(/[<>:"|?*]/, "_");

        const dragParams = {
            item: [await path.join(cfg().sampleDir, samplePath)],
            icon: ""
        };

        setFgLoading(true);
        await ensureAudioDecoded();

        if (!await checkFileExists(cfg().sampleDir, samplePath)) {
            if (cfg().placeholders) {
                await createPlaceholder(cfg().sampleDir, samplePath);
                startDrag(dragParams);
            }

            const actx = new AudioContext();

            const samples = await actx.decodeAudioData(decodedSample!.buffer);
            const channels: Float32Array[] = [];
    
            if (samples.length < 60 * 44100) {
                for (let i = 0; i < samples.numberOfChannels; i++) {
                    const chan = samples.getChannelData(i);
    
                    const start = 1200;
                    const end = ((sample.duration / 1000) * samples.sampleRate) + start;
    
                    channels.push(chan.subarray(start, end));
                }
            } else {
                // processing big samples may result in memory allocation errors (it sure did for me!!)
                console.warn(`big boi detected of ${samples.length} samples - not pre-processing!`);
            }
    
            await writeSampleFile(cfg().sampleDir, samplePath, wav.encode(channels, {
                bitDepth: 16,
                sampleRate: samples.sampleRate
            }));

            if (!cfg().placeholders) {
                startDrag(dragParams);
            }

            setFgLoading(false);
        } else {
            setFgLoading(false);
            startDrag(dragParams);
        }
    }

    return (
    <div onMouseOver={startFetching}
        className={`flex w-full px-4 py-2 gap-8 rounded transition-background
                    items-center hover:bg-foreground-100 cursor-grab select-none`}
    >
        { /* when loading, set the cursor for everything to a waiting icon */ }
        { fgLoading && <style> { `* { cursor: wait }` } </style> }

        { /* sample pack */ }
        <div className="flex gap-4 grow-0 min-w-20">
            <Tooltip content={
                <div className="flex flex-col gap-2 p-4">
                    <img src={packCover} alt={pack.name} width={128} height={128}></img>
                    <h1>{pack.name}</h1>
                </div>
            }>
                <a href={`https://splice.com/sounds/labels/${pack.permalink_base_url}`} target="_blank">
                    <img src={packCover} alt={pack.name} width={32} height={32}/>
                </a>
            </Tooltip>

            <div onClick={handlePlayClick} className="cursor-pointer w-8">
                { fgLoading ? <CircularProgress aria-label="Loading sample..." className="h-8"/> : playing ? <StopIcon/> : <PlayIcon/> }
            </div>
        </div>

        { /* sample name */ }
        <div className="grow" onMouseDown={handleDrag}>
            <div className="flex gap-1">
                {sample.name.split("/").pop()}
                <div className="text-foreground-400">({sample.asset_category_slug})</div>
            </div>

            <div className="flex gap-1">{sample.tags.map(x => (
                <Chip size="sm" key={x.uuid}>{x.label}</Chip>
            ))}</div>
        </div>

        { /* other metadata */ }
        <div className="flex gap-8" onMouseDown={handleDrag}>
            { sample.key != null ?
            <div className="flex items-center gap-2 font-semibold text-foreground-500">
                <MusicalNoteIcon className="w-4"/>
                <span>{`${sample.key.toUpperCase()}${getChordTypeDisplay(sample.chord_type)}`}</span>
            </div>
            : <></> }

            <div className="flex items-center gap-2 font-semibold text-foreground-500">
                <ClockCircleLinearIcon/>
                <span>{`${(sample.duration / 1000).toFixed(2)}s`}</span>
            </div>

            { sample.bpm != null ?
            <div className="flex items-center gap-2 font-semibold text-foreground-500">
                <ClockSquareBoldIcon/>
                <span>{`${sample.bpm} BPM`}</span>
            </div> 
            : <></> }
        </div>
    </div>
    );
}
