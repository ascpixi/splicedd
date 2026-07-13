import { SpliceSample, SpliceSearchResponse } from "../splice/api";
import { ChordType, MusicKey, SpliceTag } from "../splice/entities";

// Mock search data, used only when the app runs outside of the Tauri shell
// (i.e. `yarn dev` opened in a plain browser). This lets UI work happen with
// hot reload in a regular browser, where the splice.com helper webview that
// performs real searches doesn't exist.

const TAGS: Record<string, SpliceTag> = Object.fromEntries(
  ["drums", "kick", "snare", "bass", "synth", "melodic", "vocal", "dry", "wet",
   "trap", "house", "techno", "lo-fi", "ambient", "percussion", "fx", "guitar"]
    .map((label, i) => [label, { uuid: `tag-${i}`, label }])
);

const tagsOf = (...labels: string[]) => labels.map(x => TAGS[x]);

/** Builds a `data:` URL holding a JSON amplitude array shaped like a real Splice waveform asset. */
function mockWaveformUrl(seed: number, kind: "loop" | "decay") {
  const points: number[] = [];
  let noise = seed;

  for (let i = 0; i < 160; i++) {
    noise = (noise * 16807) % 2147483647;
    const rand = (noise % 1000) / 1000;

    const t = i / 160;
    const envelope = kind == "decay"
      ? Math.exp(-t * 5)
      : 0.55 + 0.45 * Math.sin(t * Math.PI * 8 + seed);

    points.push(Math.max(0.02, Math.min(1, envelope * (0.6 + rand * 0.4))));
  }

  return "data:application/json," + encodeURIComponent(JSON.stringify(points));
}

const PACKS = [
  { uuid: "pack-1", name: "Neon Nights - Synthwave Essentials", permalink_base_url: "mock" },
  { uuid: "pack-2", name: "Concrete Jungle Drums", permalink_base_url: "mock" },
  { uuid: "pack-3", name: "Velvet Keys & Chords", permalink_base_url: "mock" },
];

function mockSample(
  i: number,
  name: string,
  opts: {
    pack: number, bpm: number | null, key: MusicKey | null, chord: ChordType | null,
    duration: number, category: "oneshot" | "loop", tags: SpliceTag[]
  }
): SpliceSample {
  const pack = PACKS[opts.pack];
  return {
    uuid: `sample-${i}`,
    name,
    tags: opts.tags,
    files: [
      { name: "waveform", path: "", asset_file_type_slug: "waveform",
        url: mockWaveformUrl(i + 1, opts.category == "oneshot" ? "decay" : "loop") },
      { name: "preview", path: "", asset_file_type_slug: "preview_mp3", url: "data:audio/mpeg," },
    ],
    parents: {
      items: [{
        uuid: pack.uuid,
        name: pack.name,
        permalink_base_url: pack.permalink_base_url,
        files: [{ path: "", asset_file_type_slug: "cover_image", url: "img/missing-cover.png" }]
      }]
    },
    bpm: opts.bpm,
    chord_type: opts.chord,
    duration: opts.duration,
    instrument: null,
    key: opts.key,
    asset_category_slug: opts.category
  };
}

const SAMPLES: SpliceSample[] = [
  mockSample(0, "NN_120_synth_loop_midnight_drive_Cmin.wav",
    { pack: 0, bpm: 120, key: "C", chord: "minor", duration: 16000, category: "loop", tags: tagsOf("synth", "melodic", "wet") }),
  mockSample(1, "NN_analog_bass_stab_F.wav",
    { pack: 0, bpm: null, key: "F", chord: null, duration: 1250, category: "oneshot", tags: tagsOf("bass", "synth", "dry") }),
  mockSample(2, "CJD_140_drum_loop_full_gritty.wav",
    { pack: 1, bpm: 140, key: null, chord: null, duration: 6857, category: "loop", tags: tagsOf("drums", "trap", "percussion") }),
  mockSample(3, "CJD_kick_punchy_saturated.wav",
    { pack: 1, bpm: null, key: null, chord: null, duration: 640, category: "oneshot", tags: tagsOf("drums", "kick", "dry") }),
  mockSample(4, "CJD_snare_tight_layered.wav",
    { pack: 1, bpm: null, key: null, chord: null, duration: 480, category: "oneshot", tags: tagsOf("drums", "snare") }),
  mockSample(5, "VK_90_keys_loop_dusty_chords_Abmaj.wav",
    { pack: 2, bpm: 90, key: "G#", chord: "major", duration: 10667, category: "loop", tags: tagsOf("melodic", "lo-fi", "wet") }),
  mockSample(6, "VK_85_guitar_loop_lazy_sunday_Dmaj.wav",
    { pack: 2, bpm: 85, key: "D", chord: "major", duration: 11294, category: "loop", tags: tagsOf("guitar", "lo-fi", "melodic") }),
  mockSample(7, "NN_128_arp_loop_neon_cascade_Amin.wav",
    { pack: 0, bpm: 128, key: "A", chord: "minor", duration: 15000, category: "loop", tags: tagsOf("synth", "melodic", "techno") }),
  mockSample(8, "VK_vocal_chop_wistful_Em.wav",
    { pack: 2, bpm: null, key: "E", chord: "minor", duration: 2100, category: "oneshot", tags: tagsOf("vocal", "wet", "fx") }),
  mockSample(9, "CJD_174_break_loop_chopped_amen.wav",
    { pack: 1, bpm: 174, key: null, chord: null, duration: 5517, category: "loop", tags: tagsOf("drums", "percussion", "trap") }),
];

/** Returns a canned response mimicking what the Splice search endpoint would return. */
export function mockSearch(body: string): string {
  const payload = JSON.parse(body);
  const query: string = payload.variables.filepath ?? "";

  const items = SAMPLES.filter(x => x.name.toLowerCase().includes(query.toLowerCase()));

  const response: SpliceSearchResponse = {
    data: {
      assetsSearch: {
        items,
        tag_summary: [
          ...["Drums", "Synth", "Guitar", "Vocals"].map((label, i) => ({
            tag: { uuid: `instr-${i}`, label, taxonomy: { uuid: "tx-instr", name: "Instrument" as const } },
            count: 10 - i
          })),
          ...["Trap", "House", "Lo-Fi", "Techno"].map((label, i) => ({
            tag: { uuid: `genre-${i}`, label, taxonomy: { uuid: "tx-genre", name: "Genre" as const } },
            count: 10 - i
          }))
        ],
        response_metadata: { records: items.length },
        pagination_metadata: { currentPage: payload.variables.page ?? 1, totalPages: 3 }
      }
    }
  };

  return JSON.stringify(response);
}
