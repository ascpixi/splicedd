//! The hybrid filterbank of MPEG-1 Layer III - a polyphase filterbank, followed by a MDCT.

use std::f64::consts::PI;

use super::mp3::{Block, LINES};

const BANDS: usize = 32;
const SLOTS: usize = 18;

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
    /// Indexed by `phase * BANDS + band`.
    modulation: Vec<f64>,
    /// Indexed by block type, and then by `time * lines + line`. Includes the window.
    mdct: [Vec<f64>; 4],
    alias: [(f64, f64); 8],
}

impl Filterbank {
    pub fn new() -> Self {
        let prototype = (0..512)
            .map(|i| PROTOTYPE[if i <= 256 { i } else { 512 - i }] as f64 / 65536.0)
            .collect();

        let mut modulation = vec![0.0; 128 * BANDS];
        for phase in 0..128 {
            for band in 0..BANDS {
                modulation[phase * BANDS + band] = ((2 * band + 1) as f64 * (phase as f64 + 16.0) * PI / 64.0).cos();
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

        Filterbank {
            prototype,
            modulation,
            mdct,
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
        let slots = lines.len() * SLOTS;
        let mut subbands = vec![0.0; (slots + SLOTS) * BANDS];

        for (gr, (granule, &block)) in lines.iter().zip(blocks).enumerate() {
            let mut x = granule.clone();
            self.for_each_alias(block, |a, b, cs, ca| {
                (x[a], x[b]) = (x[a] * cs - x[b] * ca, x[b] * cs + x[a] * ca);
            });

            for band in 0..BANDS {
                let kind = block.kind_for(band);
                let table = &self.mdct[kind as usize];
                let x = &x[band * SLOTS..(band + 1) * SLOTS];
                let mut add = |t: usize, v: f64| subbands[(gr * SLOTS + t) * BANDS + band] += v;

                if kind == 2 {
                    for w in 0..3 {
                        for t in 0..12 {
                            add(6 + 6 * w + t, (0..6).map(|k| x[3 * k + w] * table[t * 6 + k]).sum());
                        }
                    }
                }
                else {
                    for t in 0..36 {
                        add(t, (0..18).map(|k| x[k] * table[t * 18 + k]).sum());
                    }
                }
            }
        }

        invert_frequencies(&mut subbands);

        let mut pcm = vec![0.0; slots * BANDS];
        let mut phases = [0.0; 128];
        for slot in 0..slots {
            let s = &subbands[slot * BANDS..(slot + 1) * BANDS];
            for (phase, out) in phases.iter_mut().enumerate() {
                *out = dot(s, &self.modulation[phase * BANDS..(phase + 1) * BANDS]);
            }

            for (tap, out) in pcm[slot * BANDS..].iter_mut().take(512).enumerate() {
                *out += phases[tap & 127] * self.prototype[tap];
            }
        }

        pcm
    }

    /// Converts PCM samples to the lines of consecutive granules. This is the adjoint of [`Self::synthesize`].
    pub fn analyze(&self, pcm: &[f64], blocks: &[Block]) -> Vec<Vec<f64>> {
        let slots = blocks.len() * SLOTS;
        let mut subbands = vec![0.0; (slots + SLOTS) * BANDS];

        let mut phases = [0.0; 128];
        for slot in 0..slots {
            phases.fill(0.0);
            for (tap, x) in pcm[slot * BANDS..].iter().take(512).enumerate() {
                phases[tap & 127] += x * self.prototype[tap];
            }

            let s = &mut subbands[slot * BANDS..(slot + 1) * BANDS];
            for (phase, v) in phases.iter().enumerate() {
                let row = &self.modulation[phase * BANDS..(phase + 1) * BANDS];
                for (out, m) in s.iter_mut().zip(row) {
                    *out += v * m / 32.0;
                }
            }
        }

        invert_frequencies(&mut subbands);

        blocks.iter().enumerate().map(|(gr, &block)| {
            let mut x = vec![0.0; LINES];
            for band in 0..BANDS {
                let kind = block.kind_for(band);
                let table = &self.mdct[kind as usize];
                let x = &mut x[band * SLOTS..(band + 1) * SLOTS];
                let get = |t: usize| subbands[(gr * SLOTS + t) * BANDS + band];

                if kind == 2 {
                    for w in 0..3 {
                        for k in 0..6 {
                            x[3 * k + w] = (0..12).map(|t| get(6 + 6 * w + t) * table[t * 6 + k]).sum::<f64>() / 3.0;
                        }
                    }
                }
                else {
                    for (k, out) in x.iter_mut().enumerate() {
                        *out = (0..36).map(|t| get(t) * table[t * 18 + k]).sum::<f64>() / 9.0;
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

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn invert_frequencies(subbands: &mut [f64]) {
    for slot in subbands.chunks_exact_mut(BANDS).skip(1).step_by(2) {
        for x in slot.iter_mut().skip(1).step_by(2) {
            *x = -*x;
        }
    }
}
