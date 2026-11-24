//! The hybrid filterbank of MPEG-1 Layer III - a polyphase filterbank, followed by a MDCT.
//!
//! The loops in here are ordered so that the compiler can vectorize them. The order in which the terms
//! of each individual sum are added up mustn't change, as that'd alter how the result is rounded.

use std::f64::consts::PI;

use super::mp3::{Block, LINES};

const BANDS: usize = 32;
const SLOTS: usize = 18;
const PHASES: usize = 128;
const TAPS: usize = 512;

/// The first half of the (symmetric) prototype filter, multiplied by 65536.
const PROTOTYPE: [i32; 257] = [
    0, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -3,
    -3, -4, -4, -5, -5, -6, -7, -7, -8, -9, -10, -11,
    -13, -14, -16, -17, -19, -21, -24, -26, -29, -31, -35, -38,
    -41, -45, -49, -53, -58, -63, -68, -73, -79, -85, -91, -97,
    -104, -111, -117, -125, -132, -139, -147, -154, -161, -169, -176, -183,
    -190, -196, -202, -208, -213, -218, -222, -225, -227, -228, -228, -227,
    -224, -221, -215, -208, -200, -189, -177, -163, -146, -127, -106, -83,
    -57, -29, 2, 36, 72, 111, 153, 197, 244, 294, 347, 401,
    459, 519, 581, 645, 711, 779, 848, 919, 991, 1064, 1137, 1210,
    1283, 1356, 1428, 1498, 1567, 1634, 1698, 1759, 1817, 1870, 1919, 1962,
    2001, 2032, 2057, 2075, 2085, 2087, 2080, 2063, 2037, 2000, 1952, 1893,
    1822, 1739, 1644, 1535, 1414, 1280, 1131, 970, 794, 605, 402, 185,
    -45, -288, -545, -814, -1095, -1388, -1692, -2006, -2330, -2663, -3004, -3351,
    -3705, -4063, -4425, -4788, -5153, -5517, -5879, -6237, -6589, -6935, -7271, -7597,
    -7910, -8209, -8491, -8755, -8998, -9219, -9416, -9585, -9727, -9838, -9916, -9959,
    -9966, -9935, -9863, -9750, -9592, -9389, -9139, -8840, -8492, -8092, -7640, -7134,
    -6574, -5959, -5288, -4561, -3776, -2935, -2037, -1082, -70, 998, 2122, 3300,
    4533, 5818, 7154, 8540, 9975, 11455, 12980, 14548, 16155, 17799, 19478, 21189,
    22929, 24694, 26482, 28289, 30112, 31947, 33791, 35640, 37489, 39336, 41176, 43006,
    44821, 46617, 48390, 50137, 51853, 53534, 55178, 56778, 58333, 59838, 61289, 62684,
    64019, 65290, 66494, 67629, 68692, 69679, 70590, 71420, 72169, 72835, 73415, 73908,
    74313, 74630, 74856, 74992, 75038,
];

const ALIAS: [f64; 8] = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];

/// Converts between MDCT lines and PCM samples. Both directions are linear for a given
/// sequence of blocks, and (very nearly) the inverse of one another.
pub struct Filterbank {
    /// Indexed by tap.
    prototype: Vec<f64>,
    /// Indexed by phase, and then by band.
    modulation: Vec<[f64; BANDS]>,
    /// The same as `modulation`, but indexed by band, and then by phase.
    demodulation: Vec<[f64; PHASES]>,
    /// Indexed by block type, and then by `time * lines + line`. Includes the window.
    mdct: [Vec<f64>; 4],
    /// The same as `mdct`, but indexed by block type, and then by `line * length + time`.
    imdct: [Vec<f64>; 4],
    alias: [(f64, f64); 8],
}

impl Filterbank {
    pub fn new() -> Self {
        let prototype = (0..TAPS)
            .map(|i| PROTOTYPE[if i <= 256 { i } else { TAPS - i }] as f64 / 65536.0)
            .collect();

        let mut modulation = vec![[0.0; BANDS]; PHASES];
        let mut demodulation = vec![[0.0; PHASES]; BANDS];
        for phase in 0..PHASES {
            for band in 0..BANDS {
                let value = ((2 * band + 1) as f64 * (phase as f64 + 16.0) * PI / 64.0).cos();
                modulation[phase][band] = value;
                demodulation[band][phase] = value;
            }
        }

        let mdct = [0, 1, 2, 3].map(|kind| {
            let lines = if kind == 2 { 6 } else { 18 };
            let length = lines * 2;
            let mut table = vec![0.0; length * lines];

            for i in 0..length {
                let long = (PI / 36.0 * (i as f64 + 0.5)).sin();
                let window = match (kind, i) {
                    (0, _) => long,
                    (2, _) => (PI / 12.0 * (i as f64 + 0.5)).sin(),
                    (1, 0..=17) => long,
                    (1, 18..=23) => 1.0,
                    (1, 24..=29) => (PI / 12.0 * (i as f64 - 18.0 + 0.5)).sin(),
                    (3, 6..=11) => (PI / 12.0 * (i as f64 - 6.0 + 0.5)).sin(),
                    (3, 12..=17) => 1.0,
                    (3, 18..) => long,
                    _ => 0.0
                };

                for k in 0..lines {
                    let angle = PI / (2 * length) as f64 * ((2 * i + 1 + lines) * (2 * k + 1)) as f64;
                    table[i * lines + k] = window * angle.cos();
                }
            }

            table
        });

        let imdct = [0, 1, 2, 3].map(|kind| {
            let lines = if kind == 2 { 6 } else { 18 };
            let length = lines * 2;
            (0..lines * length).map(|i| mdct[kind][i % length * lines + i / length]).collect()
        });

        Filterbank {
            prototype,
            modulation,
            demodulation,
            mdct,
            imdct,
            alias: ALIAS.map(|c| (1.0 / (1.0 + c * c).sqrt(), c / (1.0 + c * c).sqrt()))
        }
    }

    /// Calls the function with each pair of lines that's affected by alias reduction, along with its coefficients.
    fn for_each_alias(&self, block: Block, mut f: impl FnMut(usize, usize, f64, f64)) {
        let bands = match (block.kind, block.mixed) {
            (2, false) => 0,
            (2, true) => 1,
            _ => BANDS - 1
        };

        for band in 1..=bands {
            for (i, &(cs, ca)) in self.alias.iter().enumerate() {
                f(band * SLOTS - 1 - i, band * SLOTS + i, cs, ca);
            }
        }
    }

    /// Converts the lines of consecutive granules to PCM samples.
    pub fn synthesize(&self, lines: &[Vec<f64>], blocks: &[Block]) -> Vec<f64> {
        let length = lines.len() * SLOTS * BANDS;
        let mut pcm = vec![0.0; length + TAPS]; // the last few slots reach past the end

        // The subbands of the current granule, followed by the ones that overlap with the next granule.
        let mut subbands = [[0.0; BANDS]; 2 * SLOTS];

        for (gr, (granule, &block)) in lines.iter().zip(blocks).enumerate() {
            subbands.copy_within(SLOTS.., 0);
            subbands[SLOTS..].fill([0.0; BANDS]);
            self.add_granule(granule, block, &mut subbands);

            for (t, mut s) in subbands[..SLOTS].iter().copied().enumerate() {
                if t % 2 == 1 {
                    invert_frequencies(&mut s);
                }

                let at = (gr * SLOTS + t) * BANDS;
                self.add_slot(&s, &mut pcm[at..at + TAPS]);
            }
        }

        pcm.truncate(length);
        pcm
    }

    /// Adds the inverse MDCT of a granule to the subbands.
    fn add_granule(&self, granule: &[f64], block: Block, subbands: &mut [[f64; BANDS]; 2 * SLOTS]) {
        let mut x = [0.0; LINES];
        x.copy_from_slice(granule);
        self.for_each_alias(block, |a, b, cs, ca| {
            (x[a], x[b]) = (x[a] * cs - x[b] * ca, x[b] * cs + x[a] * ca);
        });

        for (band, x) in x.chunks_exact(SLOTS).enumerate() {
            // This is usually the case for the highest bands.
            if x.iter().all(|x| *x == 0.0) {
                continue;
            }

            let kind = block.kind_for(band);
            let table = &self.imdct[kind as usize];

            if kind == 2 {
                for w in 0..3 {
                    let lines: [f64; 6] = std::array::from_fn(|k| x[3 * k + w]);
                    let windowed: [f64; 12] = weighted_sum(&lines, table);
                    for (s, v) in subbands[6 + 6 * w..].iter_mut().zip(windowed) {
                        s[band] += v;
                    }
                }
            }
            else {
                let windowed: [f64; 36] = weighted_sum(x, table);
                for (s, v) in subbands.iter_mut().zip(windowed) {
                    s[band] += v;
                }
            }
        }
    }

    /// Adds the output of the polyphase filterbank for a single slot to the given PCM samples.
    fn add_slot(&self, s: &[f64; BANDS], pcm: &mut [f64]) {
        let Some(last) = s.iter().rposition(|x| *x != 0.0) else {
            return;
        };

        let phases: [f64; PHASES] = weighted_sum(&s[..=last], self.demodulation.as_flattened());
        for (pcm, prototype) in pcm.chunks_exact_mut(PHASES).zip(self.prototype.chunks_exact(PHASES)) {
            for ((out, phase), tap) in pcm.iter_mut().zip(&phases).zip(prototype) {
                *out += phase * tap;
            }
        }
    }

    /// Converts PCM samples to the lines of consecutive granules. This is the adjoint of [`Self::synthesize`].
    pub fn analyze(&self, pcm: &[f64], blocks: &[Block]) -> Vec<Vec<f64>> {
        let slots = blocks.len() * SLOTS;
        let mut subbands = vec![[0.0; BANDS]; slots + SLOTS];

        for (slot, s) in subbands[..slots].iter_mut().enumerate() {
            let pcm = &pcm[slot * BANDS..][..TAPS];
            if pcm.iter().all(|x| *x == 0.0) {
                continue;
            }

            let mut phases = [0.0; PHASES];
            for (pcm, prototype) in pcm.chunks_exact(PHASES).zip(self.prototype.chunks_exact(PHASES)) {
                for ((phase, x), tap) in phases.iter_mut().zip(pcm).zip(prototype) {
                    *phase += x * tap;
                }
            }

            for (v, row) in phases.iter().zip(&self.modulation) {
                for (out, m) in s.iter_mut().zip(row) {
                    *out += v * m / 32.0;
                }
            }

            if slot % 2 == 1 {
                invert_frequencies(s);
            }
        }

        blocks.iter().enumerate().map(|(gr, &block)| {
            let subbands = &subbands[gr * SLOTS..][..2 * SLOTS];
            let mut x = vec![0.0; LINES];

            for (band, x) in x.chunks_exact_mut(SLOTS).enumerate() {
                let kind = block.kind_for(band);
                let table = &self.mdct[kind as usize];

                if kind == 2 {
                    for w in 0..3 {
                        let samples: [f64; 12] = std::array::from_fn(|t| subbands[6 + 6 * w + t][band]);
                        let lines: [f64; 6] = weighted_sum(&samples, table);
                        for (k, v) in lines.into_iter().enumerate() {
                            x[3 * k + w] = v / 3.0;
                        }
                    }
                }
                else {
                    let samples: [f64; 36] = std::array::from_fn(|t| subbands[t][band]);
                    let lines: [f64; 18] = weighted_sum(&samples, table);
                    for (out, v) in x.iter_mut().zip(lines) {
                        *out = v / 9.0;
                    }
                }
            }

            self.for_each_alias(block, |a, b, cs, ca| {
                (x[a], x[b]) = (x[a] * cs + x[b] * ca, x[b] * cs - x[a] * ca);
            });

            x
        }).collect()
    }
}

/// Multiplies each row of the table by its weight, and adds them all up, in order.
#[inline(always)]
fn weighted_sum<const N: usize>(weights: &[f64], table: &[f64]) -> [f64; N] {
    let mut sum = [0.0; N];
    let row = |i: usize| -> &[f64; N] { table[i * N..][..N].try_into().unwrap() };

    // Going through several rows at once means having to load and store the sum less often.
    let mut groups = weights.chunks_exact(4);
    let mut at = 0;
    for w in &mut groups {
        let (a, b, c, d) = (row(at), row(at + 1), row(at + 2), row(at + 3));
        for i in 0..N {
            sum[i] = sum[i] + w[0] * a[i] + w[1] * b[i] + w[2] * c[i] + w[3] * d[i];
        }
        at += 4;
    }

    for w in groups.remainder() {
        for (out, x) in sum.iter_mut().zip(row(at)) {
            *out += w * x;
        }
        at += 1;
    }

    sum
}

/// Inverts every other band. This is done for every other slot.
fn invert_frequencies(s: &mut [f64; BANDS]) {
    for x in s.iter_mut().skip(1).step_by(2) {
        *x = -*x;
    }
}
