//! Restores the lossless samples that Splice's MP3 previews were made out of, as closely as possible.
//!
//! The previews are made by LAME 3.100 (`-b 128 -q 0`, without a Xing header). Besides quantizing
//! the audio, it also delays it and makes it slightly quieter - both of which can be perfectly undone.

mod filterbank;
mod huffman;
mod mp3;
mod onset;

use std::f64::consts::SQRT_2;
use std::time::Instant;

use serde::Deserialize;
use tauri::ipc::{Request, Response};

use crate::files::{fail, read_body};
use crate::logging::ms;
use filterbank::Filterbank;
use mp3::{Block, Mp3, LINES, MAX_QUANTIZED};

/// The number of samples that precede the actual audio - that's the delay of LAME (576), and of any
/// MP3 decoder (529). Decoders might hide the latter, but ours doesn't.
const DELAY: usize = 576 + 529;

/// What LAME multiplies its input by when encoding to 128 kbps.
const SCALE_128K: f64 = 0.95;

/// Indexed by channel, granule, and line.
type Lines = Vec<Vec<Vec<f64>>>;

struct Restored {
    channels: Vec<Vec<f64>>,
    sample_rate: u32,
}

/// Converts between mid/side and left/right, for the frames that are encoded as mid/side.
fn toggle_mid_side(mp3: &Mp3, lines: &mut Lines) {
    let [left, right] = &mut lines[..] else {
        return;
    };

    for (gr, (left, right)) in left.iter_mut().zip(right).enumerate() {
        if !mp3.frames[gr / 2].mid_side {
            continue;
        }

        for (l, r) in left.iter_mut().zip(right) {
            (*l, *r) = ((*l + *r) / SQRT_2, (*l - *r) / SQRT_2);
        }
    }
}

/// Retrieves the dequantized lines, along with the blocks of each channel.
fn dequantize(mp3: &Mp3) -> (Lines, Vec<Vec<Block>>) {
    // Raising each line to a power on its own would be really slow.
    let powers: Vec<f64> = (0..=MAX_QUANTIZED).map(|q| (q as f64).powf(4.0 / 3.0)).collect();

    (0..mp3.channels)
        .map(|ch| {
            mp3.frames.iter()
                .flat_map(|x| &x.granules)
                .map(|x| {
                    let lines: Vec<f64> = x[ch].quantized.iter().zip(&x[ch].step)
                        .map(|(&q, step)| powers[q.unsigned_abs() as usize] * q.signum() as f64 * step)
                        .collect();
                    (lines, x[ch].block)
                })
                .unzip()
        })
        .unzip()
}

/// Determines the length of the original sample. We only know its duration in milliseconds
/// (usually rounded down), but loops are always made out of a whole number of beats, which lets us be exact.
fn original_length(duration_ms: f64, loop_bpm: Option<f64>, sample_rate: u32) -> usize {
    let rate = sample_rate as f64;

    if let Some(bpm) = loop_bpm.filter(|x| *x > 0.0) {
        let beats = (duration_ms / 60_000.0 * bpm).round();
        let exact_ms = beats * 60_000.0 / bpm;
        if beats > 0.0 && (-0.6..1.1).contains(&(exact_ms - duration_ms)) {
            return (exact_ms / 1000.0 * rate - 1e-6).ceil() as usize;
        }
    }

    // Make sure not to cut anything off.
    ((duration_ms + 1.0) / 1000.0 * rate).ceil() as usize
}

fn restore(data: &[u8], duration_ms: f64, loop_bpm: Option<f64>) -> Result<Restored, String> {
    let mp3 = mp3::parse(data)?;
    let filterbank = Filterbank::new();

    let (quantized, blocks) = dequantize(&mp3);
    let mut lines = quantized.clone();
    toggle_mid_side(&mp3, &mut lines);

    let mut channels: Vec<Vec<f64>> = lines.iter().zip(&blocks)
        .map(|(lines, blocks)| filterbank.synthesize(lines, blocks))
        .collect();
    onset::repair(&mp3, &filterbank, &quantized, &blocks, &mut channels);

    let gain = if mp3.bitrate == 128 { 1.0 / SCALE_128K } else { 1.0 };
    let length = original_length(duration_ms, loop_bpm, mp3.sample_rate);

    for channel in &mut channels {
        channel.drain(..DELAY.min(channel.len()));
        channel.resize(length, 0.0);

        // The original never exceeded full scale, so anything that does is caused by the MP3.
        for x in channel {
            *x = (*x * gain).clamp(-1.0, 1.0);
        }
    }

    Ok(Restored { channels, sample_rate: mp3.sample_rate })
}

/// Encodes the sample as a 24-bit WAV file.
fn encode_wav(sample: &Restored) -> Vec<u8> {
    let channels = sample.channels.len();
    let length = sample.channels.first().map_or(0, |x| x.len());
    let size = (length * channels * 3) as u32;
    let padding = size & 1;

    let mut out = Vec::with_capacity(44 + (size + padding) as usize);
    out.extend(b"RIFF");
    out.extend((36 + size + padding).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend((channels as u16).to_le_bytes());
    out.extend(sample.sample_rate.to_le_bytes());
    out.extend((sample.sample_rate * channels as u32 * 3).to_le_bytes());
    out.extend((channels as u16 * 3).to_le_bytes());
    out.extend(24u16.to_le_bytes());
    out.extend(b"data");
    out.extend(size.to_le_bytes());

    for i in 0..length {
        for channel in &sample.channels {
            let value = (channel[i] * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
            out.extend(&value.to_le_bytes()[..3]);
        }
    }

    out.resize(out.len() + padding as usize, 0);
    out
}

/// The header that describes the sample sent over as the body of a `restore_sample` request.
const SAMPLE_HEADER: &str = "sample";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleInfo {
    duration_ms: f64,
    loop_bpm: Option<f64>,
}

fn parse_sample_info(request: &Request) -> Result<SampleInfo, String> {
    let header = request.headers().get(SAMPLE_HEADER)
        .ok_or_else(|| format!("Missing the {SAMPLE_HEADER} header"))?;

    serde_json::from_slice(header.as_bytes())
        .map_err(|e| format!("Malformed {SAMPLE_HEADER} header: {e}"))
}

/// Restores a MP3 preview, which makes up the body of the request. Responds with a WAV file.
/// This fails if the preview isn't in a format we know how to restore.
#[tauri::command]
pub async fn restore_sample(request: Request<'_>) -> Result<Response, String> {
    let SampleInfo { duration_ms, loop_bpm } = match parse_sample_info(&request) {
        Ok(info) => info,
        Err(e) => return fail(e),
    };

    let data = match read_body(&request) {
        Ok(data) => data,
        Err(e) => return fail(e),
    };

    let started = Instant::now();
    let restored = restore(&data, duration_ms, loop_bpm)?;
    let restored_in = started.elapsed();
    let encoded = encode_wav(&restored);

    log::info!(
        "restored {} bytes to {} channels of {} samples at {} Hz in {} (of which encoding took {})",
        data.len(), restored.channels.len(), restored.channels[0].len(), restored.sample_rate,
        ms(started.elapsed()), ms(started.elapsed() - restored_in)
    );

    Ok(Response::new(encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filterbank_is_invertible() {
        let filterbank = Filterbank::new();
        let kinds = [0, 0, 1, 2, 3, 0, 0, 1, 2, 2, 3, 0, 0, 0];
        let blocks: Vec<Block> = kinds.iter().map(|&kind| Block { kind, mixed: false }).collect();

        let mut seed = 1u32;
        let lines: Vec<Vec<f64>> = blocks.iter()
            .map(|_| (0..LINES).map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if i < 400 { seed as f64 / u32::MAX as f64 - 0.5 } else { 0.0 }
            }).collect())
            .collect();

        let mut pcm = filterbank.synthesize(&lines, &blocks);
        pcm.resize(pcm.len() + 2048, 0.0);
        let back = filterbank.analyze(&pcm, &blocks);

        let (mut signal, mut error) = (0.0, 0.0);
        for (a, b) in lines[..11].iter().flatten().zip(back[..11].iter().flatten()) {
            signal += a * a;
            error += (a - b) * (a - b);
        }

        assert!(10.0 * (signal / error).log10() > 70.0);
    }

    #[test]
    fn loops_are_a_whole_number_of_beats() {
        assert_eq!(original_length(5647.0, Some(85.0), 44100), 249_036);
        assert_eq!(original_length(2000.0, Some(120.0), 48000), 96_000);

        // not a whole number of beats
        assert_eq!(original_length(2100.0, Some(120.0), 48000), 100_848);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(restore(&[], 100.0, None).is_err());
        assert!(restore(&[0xff; 4096], 100.0, None).is_err());
        assert!(restore(&[0x12; 4096], 100.0, None).is_err());
    }
}
