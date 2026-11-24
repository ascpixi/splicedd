//! A MPEG-1 Layer III bitstream parser.
//!
//! Regular decoders only give access to the final PCM. To undo the damage done by the encoder,
//! we also need to know *how* each MDCT coefficient was quantized - this is what this parser is for.

use super::huffman as h;

/// The number of MDCT lines in a granule.
pub const LINES: usize = 576;

const SFB_LONG: [[usize; 23]; 3] = [
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 52, 62, 74, 90, 110, 134, 162, 196, 238, 288, 342, 418, 576],
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 50, 60, 72, 88, 106, 128, 156, 190, 230, 276, 330, 384, 576],
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 54, 66, 82, 102, 126, 156, 194, 240, 296, 364, 448, 550, 576],
];

const SFB_SHORT: [[usize; 14]; 3] = [
    [0, 4, 8, 12, 16, 22, 30, 40, 52, 66, 84, 106, 136, 192],
    [0, 4, 8, 12, 16, 22, 28, 38, 50, 64, 80, 100, 126, 192],
    [0, 4, 8, 12, 16, 22, 30, 42, 58, 78, 104, 138, 180, 192],
];

const PRETAB: [i32; 22] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 2, 0];
const SLEN1: [u32; 16] = [0, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4];
const SLEN2: [u32; 16] = [0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 2, 3];
const BITRATES: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const RATES: [u32; 3] = [44100, 48000, 32000];

/// How the lines of a granule are transformed into the time domain.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Block {
    /// 0 = long, 1 = start, 2 = short, 3 = stop.
    pub kind: u8,
    /// Whether the lowest two subbands of a short block are long.
    pub mixed: bool,
}

impl Block {
    /// The type of block used for the given subband.
    pub fn kind_for(&self, subband: usize) -> u8 {
        if self.mixed && subband < 2 { 0 } else { self.kind }
    }
}

/// The quantized lines of one channel in one granule, ordered by frequency. Lines of short
/// blocks are interleaved, i.e. ordered by frequency first, and then by window.
#[derive(Clone)]
pub struct Granule {
    pub quantized: Vec<i32>,
    /// What each line is to be scaled by after raising its quantized value to the power of 4/3.
    pub step: Vec<f64>,
    pub block: Block,
}

impl Granule {
    fn silent() -> Self {
        Granule { quantized: vec![0; LINES], step: vec![0.0; LINES], block: Block::default() }
    }
}

pub struct Frame {
    /// Indexed by granule (two per frame), and then by channel.
    pub granules: [Vec<Granule>; 2],
    /// Whether the channels represent mid/side instead of left/right.
    pub mid_side: bool,
}

pub struct Mp3 {
    pub sample_rate: u32,
    pub channels: usize,
    pub bitrate: u32,
    pub frames: Vec<Frame>,
}

struct Header {
    sample_rate: u32,
    rate_index: usize,
    bitrate: u32,
    channels: usize,
    mode_extension: u32,
    crc: bool,
    size: usize,
}

/// Parses a frame header. Returns `Ok(None)` if there's none here.
fn parse_header(d: &[u8]) -> Result<Option<Header>, String> {
    if d.len() < 4 || d[0] != 0xff || d[1] & 0xe0 != 0xe0 {
        return Ok(None);
    }

    let version = (d[1] >> 3) & 3;
    let layer = (d[1] >> 1) & 3;
    let bitrate_index = (d[2] >> 4) as usize;
    let rate_index = ((d[2] >> 2) & 3) as usize;
    if version == 1 || layer != 1 || rate_index == 3 || bitrate_index == 0 || bitrate_index == 15 {
        return Ok(None);
    }

    if version != 3 {
        return Err("only MPEG-1 Layer III is supported".into());
    }

    let bitrate = BITRATES[bitrate_index];
    let sample_rate = RATES[rate_index];
    let mode = (d[3] >> 6) & 3;

    Ok(Some(Header {
        sample_rate,
        rate_index,
        bitrate,
        channels: if mode == 3 { 1 } else { 2 },
        mode_extension: if mode == 1 { ((d[3] >> 4) & 3) as u32 } else { 0 },
        crc: d[1] & 1 == 0,
        size: (144_000 * bitrate / sample_rate) as usize + ((d[2] >> 1) & 1) as usize,
    }))
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> u32 {
        let byte = self.data.get(self.pos >> 3).copied().unwrap_or(0);
        let bit = (byte >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        bit as u32
    }

    fn get(&mut self, n: u32) -> u32 {
        (0..n).fold(0, |acc, _| acc << 1 | self.bit())
    }
}

/// A binary tree for looking up Huffman codes. Positive nodes are branches, negative ones are leaves.
struct Tree(Vec<[i32; 2]>);

impl Tree {
    fn new(codes: &[(u8, u16, u8, u8)]) -> Self {
        let mut nodes = vec![[0i32; 2]];
        for &(len, code, x, y) in codes {
            let mut at = 0;
            for i in (0..len).rev() {
                let bit = ((code as u32 >> i) & 1) as usize;
                if i == 0 {
                    nodes[at][bit] = -1 - ((x as i32) << 4 | y as i32);
                }
                else {
                    if nodes[at][bit] == 0 {
                        nodes.push([0; 2]);
                        nodes[at][bit] = nodes.len() as i32 - 1;
                    }

                    at = nodes[at][bit] as usize;
                }
            }
        }

        Tree(nodes)
    }

    fn read(&self, bits: &mut Bits) -> (usize, usize) {
        let mut at = 0usize;
        loop {
            let next = self.0[at][bits.bit() as usize];
            if next < 0 {
                let value = (-1 - next) as usize;
                return (value >> 4, value & 15);
            }

            at = next as usize;
        }
    }
}

struct Tables {
    pairs: Vec<Option<Tree>>,
    quads: [Tree; 2],
}

impl Tables {
    fn new() -> Self {
        let pairs = (0..32)
            .map(|i| {
                let codes = match i {
                    1 => h::T1, 2 => h::T2, 3 => h::T3, 5 => h::T5, 6 => h::T6, 7 => h::T7,
                    8 => h::T8, 9 => h::T9, 10 => h::T10, 11 => h::T11, 12 => h::T12, 13 => h::T13,
                    15 => h::T15, 16..=23 => h::T16, 24..=31 => h::T24,
                    _ => return None
                };
                Some(Tree::new(codes))
            })
            .collect();

        // The codes of the second quad table are fixed-length.
        Tables { pairs, quads: [Tree::new(h::QA), Tree::new(h::QB)] }
    }
}

const LINBITS: [u32; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 2, 3, 4, 6, 8, 10, 13, 4, 5, 6, 7, 8, 9, 11, 13,
];

#[derive(Default, Clone)]
struct SideInfo {
    part2_3_length: usize,
    big_values: usize,
    global_gain: i32,
    scalefac_compress: usize,
    block: Block,
    tables: [usize; 3],
    subblock_gain: [i32; 3],
    regions: [usize; 2],
    preflag: bool,
    scalefac_scale: bool,
    count1_table: usize,
}

fn read_side_info(b: &mut Bits, rate: usize) -> SideInfo {
    let mut s = SideInfo {
        part2_3_length: b.get(12) as usize,
        big_values: b.get(9) as usize,
        global_gain: b.get(8) as i32,
        scalefac_compress: b.get(4) as usize,
        ..Default::default()
    };

    if b.bit() == 1 {
        s.block = Block { kind: b.get(2) as u8, mixed: b.bit() == 1 };
        s.tables = [b.get(5) as usize, b.get(5) as usize, 0];
        s.subblock_gain = [b.get(3) as i32, b.get(3) as i32, b.get(3) as i32];
        s.regions = if s.block.kind == 2 && !s.block.mixed {
            [SFB_SHORT[rate][3] * 3, LINES]
        }
        else {
            [SFB_LONG[rate][8], LINES]
        };
    }
    else {
        s.tables = [b.get(5) as usize, b.get(5) as usize, b.get(5) as usize];
        let r0 = b.get(4) as usize;
        let r1 = b.get(3) as usize;
        s.regions = [SFB_LONG[rate][(r0 + 1).min(22)], SFB_LONG[rate][(r0 + r1 + 2).min(22)]];
    }

    s.preflag = b.bit() == 1;
    s.scalefac_scale = b.bit() == 1;
    s.count1_table = b.bit() as usize;
    s
}

/// The scale factors of a granule. Short ones are indexed by band, and then by window.
#[derive(Default, Clone)]
struct ScaleFactors {
    long: [i32; 22],
    short: [[i32; 3]; 13],
}

fn read_scale_factors(b: &mut Bits, s: &SideInfo, scfsi: [bool; 4], previous: &ScaleFactors) -> ScaleFactors {
    let (slen1, slen2) = (SLEN1[s.scalefac_compress], SLEN2[s.scalefac_compress]);
    let mut out = ScaleFactors::default();

    if s.block.kind == 2 {
        let mut first_short = 0;
        if s.block.mixed {
            for sfb in 0..8 {
                out.long[sfb] = b.get(slen1) as i32;
            }
            first_short = 3;
        }

        for sfb in first_short..12 {
            for w in 0..3 {
                out.short[sfb][w] = b.get(if sfb < 6 { slen1 } else { slen2 }) as i32;
            }
        }
    }
    else {
        for (group, range) in [0..6, 6..11, 11..16, 16..21].into_iter().enumerate() {
            for sfb in range {
                out.long[sfb] = if scfsi[group] {
                    previous.long[sfb]
                }
                else {
                    b.get(if group < 2 { slen1 } else { slen2 }) as i32
                };
            }
        }
    }

    out
}

fn read_lines(b: &mut Bits, s: &SideInfo, tables: &Tables, end: usize) -> Vec<i32> {
    let mut lines = vec![0i32; LINES];
    let big = (s.big_values * 2).min(LINES);

    let mut i = 0;
    while i < big {
        let region = if i < s.regions[0] { 0 } else if i < s.regions[1] { 1 } else { 2 };
        let table = s.tables[region];

        if let Some(tree) = &tables.pairs[table] {
            let (x, y) = tree.read(b);
            for (k, v) in [x, y].into_iter().enumerate() {
                let mut v = v as i32;
                if v == 15 && LINBITS[table] > 0 {
                    v += b.get(LINBITS[table]) as i32;
                }

                lines[i + k] = if v != 0 && b.bit() == 1 { -v } else { v };
            }
        }

        i += 2;
    }

    while i + 4 <= LINES && b.pos < end {
        let (v, w) = tables.quads[s.count1_table].read(b);
        let pattern = v << 4 | w;
        let mut quad = [0; 4];
        for (k, q) in quad.iter_mut().enumerate() {
            if pattern >> (7 - k) & 1 == 1 || pattern >> (3 - k) & 1 == 1 {
                *q = if b.bit() == 1 { -1 } else { 1 };
            }
        }

        if b.pos > end {
            break; // this one is made out of stuffing bits
        }

        lines[i..i + 4].copy_from_slice(&quad);
        i += 4;
    }

    lines
}

/// Determines the step size of each line, and puts them in order of their frequency.
fn assemble(lines: Vec<i32>, s: &SideInfo, sf: &ScaleFactors, rate: usize) -> Granule {
    let mut granule = Granule::silent();
    granule.block = s.block;

    let scale = if s.scalefac_scale { 1.0 } else { 0.5 };
    let base = (s.global_gain - 210) as f64 / 4.0;

    let short = s.block.kind == 2;
    let long_bands = match (short, s.block.mixed) {
        (true, true) => 8,
        (true, false) => 0,
        (false, _) => 22
    };

    for sfb in 0..long_bands {
        let pre = if s.preflag { PRETAB[sfb] } else { 0 };
        let step = (base - scale * (sf.long[sfb] + pre) as f64).exp2();

        for i in SFB_LONG[rate][sfb]..SFB_LONG[rate][sfb + 1] {
            granule.quantized[i] = lines[i];
            granule.step[i] = step;
        }
    }

    if short {
        for sfb in (if s.block.mixed { 3 } else { 0 })..13 {
            let start = SFB_SHORT[rate][sfb];
            let width = SFB_SHORT[rate][sfb + 1] - start;

            for w in 0..3 {
                let gain = base - 2.0 * s.subblock_gain[w] as f64 - scale * sf.short[sfb][w] as f64;
                let step = gain.exp2();

                for i in 0..width {
                    let to = 3 * (start + i) + w;
                    granule.quantized[to] = lines[3 * start + w * width + i];
                    granule.step[to] = step;
                }
            }
        }
    }

    granule
}

/// Parses a MP3 file. Tags and any other garbage before and after its frames are skipped.
pub fn parse(data: &[u8]) -> Result<Mp3, String> {
    let mut at = 0;
    if data.len() > 10 && &data[..3] == b"ID3" {
        at = 10 + data[6..10].iter().fold(0, |acc, &x| acc << 7 | (x & 0x7f) as usize);
    }

    let tables = Tables::new();
    let mut mp3 = Mp3 { sample_rate: 0, channels: 0, bitrate: 0, frames: vec![] };
    let mut reservoir: Vec<u8> = vec![];

    while at + 4 <= data.len() {
        let Some(header) = parse_header(&data[at..])? else {
            at += 1;
            continue;
        };

        let followed_by_frame = match data.get(at + header.size..) {
            None => false,
            Some(rest) => rest.len() < 4 || parse_header(rest)?.is_some()
        };

        // Don't get fooled by data that happens to look like a header.
        if mp3.frames.is_empty() && !followed_by_frame {
            at += 1;
            continue;
        }

        let side_size = if header.channels == 1 { 17 } else { 32 };
        let side_at = at + 4 + if header.crc { 2 } else { 0 };
        let end = at + header.size;
        if end > data.len() || side_at + side_size > end {
            break; // truncated
        }

        if mp3.frames.is_empty() {
            let first = &data[side_at + side_size..end.min(side_at + side_size + 4)];
            if first == b"Xing" || first == b"Info" {
                // It's best not to guess how the rest of the file was made.
                return Err("the file has a Xing header".into());
            }

            mp3.sample_rate = header.sample_rate;
            mp3.channels = header.channels;
            mp3.bitrate = header.bitrate;
        }
        else if header.sample_rate != mp3.sample_rate || header.channels != mp3.channels {
            return Err("the format changes mid-stream".into());
        }

        if header.mode_extension & 1 != 0 {
            return Err("intensity stereo isn't supported".into());
        }

        let mut bits = Bits { data: &data[side_at..side_at + side_size], pos: 0 };
        let main_data_begin = bits.get(9) as usize;
        bits.get(if header.channels == 1 { 5 } else { 3 });

        let scfsi: Vec<[bool; 4]> = (0..header.channels)
            .map(|_| [0; 4].map(|_| bits.bit() == 1))
            .collect();
        let sides: Vec<Vec<SideInfo>> = (0..2)
            .map(|_| (0..header.channels).map(|_| read_side_info(&mut bits, header.rate_index)).collect())
            .collect();

        let available = main_data_begin <= reservoir.len();
        let mut main = reservoir[reservoir.len().saturating_sub(main_data_begin)..].to_vec();
        main.extend_from_slice(&data[side_at + side_size..end]);

        let mut granules = [vec![], vec![]];
        let mut previous = vec![ScaleFactors::default(); header.channels];
        let mut bits = Bits { data: &main, pos: 0 };

        for (gr, infos) in sides.iter().enumerate() {
            for (ch, s) in infos.iter().enumerate() {
                if !available {
                    granules[gr].push(Granule::silent());
                    continue;
                }

                let end = bits.pos + s.part2_3_length;
                let shared = if gr == 1 { scfsi[ch] } else { [false; 4] };
                let factors = read_scale_factors(&mut bits, s, shared, &previous[ch]);
                let lines = read_lines(&mut bits, s, &tables, end);
                bits.pos = end;

                granules[gr].push(assemble(lines, s, &factors, header.rate_index));
                previous[ch] = factors;
            }
        }

        mp3.frames.push(Frame { granules, mid_side: header.mode_extension & 2 != 0 });

        let keep = main.len().saturating_sub(511);
        reservoir = main.split_off(keep);
        at = end;
    }

    if mp3.frames.is_empty() {
        return Err("no MPEG audio frames found".into());
    }

    Ok(mp3)
}
