//! Repairs the onset of a sample.
//!
//! Samples are silent before they start, so anything that's there in the decoded audio was put there
//! by the encoder - in other words, it's a direct measurement of the quantization error. The very same
//! error also extends into the onset, and as we know how coarsely each line was quantized, we can work
//! out what it most likely looks like there, and then subtract it.

use std::f64::consts::PI;

use super::filterbank::Filterbank;
use super::mp3::{Block, Mp3, LINES};
use super::{toggle_mid_side, Lines, DELAY};

/// The number of granules considered. Those that follow don't overlap with the silence.
const GRANULES: usize = 6;

/// The number of conjugate gradient iterations.
const ITERATIONS: usize = 25;

/// The noise expected in the silence, relative to the peak. This accounts for the imperfections of the filterbank.
const NOISE: f64 = 1e-8;

/// When the correction is fully applied until, and when it fades out by, in seconds. The further away from
/// the silence, the less it tells us about the error.
const FADE: (f64, f64) = (0.001, 0.003);

/// LAME discards everything from here onwards, in Hz.
const CUTOFF: f64 = 16537.5;

type Signal = Vec<Vec<f64>>;

struct Solver<'a> {
    mp3: &'a Mp3,
    filterbank: &'a Filterbank,
    blocks: Vec<&'a [Block]>,
    variance: Lines,
    length: usize,
}

impl Solver<'_> {
    fn synthesize(&self, lines: &Lines) -> Signal {
        let mut lines = lines.clone();
        toggle_mid_side(self.mp3, &mut lines);
        lines.iter().zip(&self.blocks)
            .map(|(lines, blocks)| self.filterbank.synthesize(lines, blocks))
            .collect()
    }

    /// Multiplies by the adjoint of [`Self::synthesize`], and by the variance of each line.
    fn expected_error(&self, signal: &Signal) -> Lines {
        let mut lines: Lines = signal.iter().zip(&self.blocks)
            .map(|(signal, blocks)| {
                let mut padded = signal.clone();
                padded.resize(self.length + 2048, 0.0);

                let mut lines = self.filterbank.analyze(&padded, blocks);
                for (granule, block) in lines.iter_mut().zip(*blocks) {
                    for x in granule {
                        *x *= if block.kind == 2 { 96.0 } else { 288.0 };
                    }
                }
                lines
            })
            .collect();

        toggle_mid_side(self.mp3, &mut lines);
        for (x, v) in lines.iter_mut().flatten().flatten().zip(self.variance.iter().flatten().flatten()) {
            *x *= v;
        }
        lines
    }
}

fn keep_silence(mut signal: Signal) -> Signal {
    for x in &mut signal {
        x[DELAY..].fill(0.0);
    }
    signal
}

fn dot(a: &Signal, b: &Signal) -> f64 {
    a.iter().flatten().zip(b.iter().flatten()).map(|(x, y)| x * y).sum()
}

/// Computes `a += b * scale`.
fn add_scaled(a: &mut Signal, b: &Signal, scale: f64) {
    for (x, y) in a.iter_mut().flatten().zip(b.iter().flatten()) {
        *x += y * scale;
    }
}

/// The expected squared error of each line of a granule.
fn line_variance(quantized: &[i32], step: &[f64], cutoff: usize) -> Vec<f64> {
    if quantized.iter().all(|x| *x == 0) {
        return vec![0.0; LINES];
    }

    // The lines above the cutoff are missing altogether. Guess how loud they were from those just below it.
    let below = cutoff - 72..cutoff;
    let energy: f64 = quantized[below.clone()].iter().zip(&step[below])
        .map(|(&q, step)| ((q.abs() as f64).powf(8.0 / 3.0) + 0.1) * step * step)
        .sum();
    let missing = energy / 72.0 * 0.5;

    (0..LINES)
        .map(|i| {
            if i >= cutoff {
                return missing * (1.0 - (i - cutoff) as f64 / (LINES - cutoff) as f64 * 0.7);
            }

            let q = quantized[i].abs() as f64;
            let variance = if q == 0.0 {
                0.1
            }
            else {
                ((q + 0.5946).powf(4.0 / 3.0) - (q - 0.4054).powf(4.0 / 3.0)).powi(2) / 12.0
            };
            variance * step[i] * step[i]
        })
        .collect()
}

/// Makes sure that the line is still something that LAME would've quantized the same way.
fn constrain(value: f64, quantized: i32, step: f64, audible: bool) -> f64 {
    if quantized == 0 {
        return if audible { value.clamp(-0.65 * step, 0.65 * step) } else { 0.0 };
    }

    let q = quantized.abs() as f64;
    let sign = quantized.signum() as f64;
    sign * (value * sign).clamp((q - 0.45).powf(4.0 / 3.0) * step, (q + 0.6).powf(4.0 / 3.0) * step)
}

/// Repairs the onset of the decoded audio given in `channels`.
pub fn repair(mp3: &Mp3, filterbank: &Filterbank, quantized: &Lines, blocks: &[Vec<Block>], channels: &mut [Vec<f64>]) {
    let count = GRANULES.min(blocks[0].len());
    let length = count * LINES;
    if length <= DELAY {
        return;
    }

    let granule = |ch: usize, gr: usize| &mp3.frames[gr / 2].granules[gr % 2][ch];
    let map_lines = |f: &dyn Fn(usize, usize) -> Vec<f64>| -> Lines {
        (0..mp3.channels).map(|ch| (0..count).map(|gr| f(ch, gr)).collect()).collect()
    };

    let cutoff = (((CUTOFF / mp3.sample_rate as f64 * 64.0).round() * 18.0) as usize).clamp(72, LINES - 1);
    let solver = Solver {
        mp3,
        filterbank,
        blocks: blocks.iter().map(|x| &x[..count]).collect(),
        variance: map_lines(&|ch, gr| line_variance(&granule(ch, gr).quantized, &granule(ch, gr).step, cutoff)),
        length,
    };

    let original = map_lines(&|ch, gr| quantized[ch][gr].clone());
    let before = solver.synthesize(&original);
    let peak = before.iter().flatten().fold(0.0f64, |acc, x| acc.max(x.abs()));
    if peak == 0.0 {
        return;
    }

    let silence = keep_silence(before.clone());
    let observed = dot(&silence, &silence);
    let noise = NOISE * peak * peak;

    // Find the most likely error that'd explain what we see in the silence.
    let mut residual = silence;
    let mut solution: Signal = vec![vec![0.0; length]; mp3.channels];
    for x in residual.iter_mut().flatten() {
        *x = -*x;
    }

    let mut direction = residual.clone();
    let mut energy = observed;

    for _ in 0..ITERATIONS {
        if energy < 1e-16 {
            break;
        }

        let mut image = keep_silence(solver.synthesize(&solver.expected_error(&direction)));
        add_scaled(&mut image, &direction, noise);

        let scale = energy / dot(&direction, &image);
        add_scaled(&mut solution, &direction, scale);
        add_scaled(&mut residual, &image, -scale);

        let previous = energy;
        energy = dot(&residual, &residual);

        let mut next = residual.clone();
        add_scaled(&mut next, &direction, energy / previous);
        direction = next;
    }

    let mut corrected = solver.expected_error(&solution);
    for ch in 0..mp3.channels {
        for gr in 0..count {
            let g = granule(ch, gr);
            for (i, x) in corrected[ch][gr].iter_mut().enumerate() {
                *x = constrain(*x + original[ch][gr][i], g.quantized[i], g.step[i], i < 396);
            }
        }
    }

    let mut correction = solver.synthesize(&corrected);
    add_scaled(&mut correction, &before, -1.0);
    if correction.iter().flatten().any(|x| !x.is_finite()) {
        log::warn!("the onset repair diverged");
        return;
    }

    // If it'd change far more than what we could've observed, then the correction can't be trusted.
    let applied: f64 = correction.iter().flat_map(|x| &x[DELAY..]).map(|x| x * x).sum();
    let strength = (observed / applied.max(1e-30)).sqrt().min(1.0);

    for (channel, correction) in channels.iter_mut().zip(&correction) {
        for (i, (x, c)) in channel.iter_mut().zip(correction).enumerate() {
            let time = i.saturating_sub(DELAY) as f64 / mp3.sample_rate as f64;
            let t = ((time - FADE.0) / (FADE.1 - FADE.0)).clamp(0.0, 1.0);
            *x += c * strength * (0.5 + 0.5 * (PI * t).cos());
        }
    }
}
