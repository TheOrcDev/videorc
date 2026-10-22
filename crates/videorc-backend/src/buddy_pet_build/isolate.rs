//! S-F2: separate characters whose horizontal extents overlap, a port of
//! page-pet's `scripts/isolate_strip.py` with the plan's ownership rule.
//!
//! Visible pixels (alpha above 16) are labelled with a union-find over
//! 8-connected neighbours. The `count` largest components are the
//! characters, ordered left to right (and top to bottom for multi-row
//! sheets) by their mean pixel position. Every smaller component joins the
//! nearest character by bounding-box gap when it lies within
//! [`LOOSE_PIECE_JOIN_PX`]; a piece further away fails the sheet, because
//! the builder never drops pixels and never guesses an owner. Faint pixels
//! (alpha 1 to 16, invisible to every later measurement) follow the nearest
//! character so that no alpha is lost. The owned pixels of each character
//! are copied, never resampled, into their own cell of a new sheet with
//! 24 px of clear gutter on each side; the cut then runs on that sheet.

use image::RgbaImage;

use super::VISIBLE_ALPHA;
use super::cut::SourceBox;

/// Maximum bounding-box gap for a detached piece (a sparkle, a tear, a
/// fingertip) to join the nearest character.
pub const LOOSE_PIECE_JOIN_PX: f64 = 24.0;

/// Clear space added on each side of every isolated character
/// (page-pet: `cell = max width + 48`).
pub(super) const ISOLATED_GUTTER_PX: u32 = 24;

/// A character must cover at least this share of the sheet divided by the
/// expected count (page-pet: `alpha.size * (.125 / count)`).
const MIN_CHARACTER_SHARE: f64 = 0.125;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum IsolateFailure {
    /// Fewer distinct full-size characters than the grid expects (touching
    /// characters count as one).
    TooFewCharacters { expected: usize, found: usize },
    /// A visible piece sits further than [`LOOSE_PIECE_JOIN_PX`] from every
    /// character.
    LoosePiece { distance: f64, bounds: SourceBox },
    /// The copied alpha does not match the source; an internal error.
    PixelsLost,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Isolated {
    /// The new sheet: one character per cell, pixels copied as they were.
    pub image: RgbaImage,
    /// Bounds of each character's owned pixels (alpha above 0) in the
    /// original sheet, in cell order.
    pub owned_bounds: Vec<SourceBox>,
}

struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    fn new() -> Self {
        // Label 0 is the background and never unioned.
        Self { parent: vec![0] }
    }

    fn make(&mut self) -> u32 {
        let id = self.parent.len() as u32;
        self.parent.push(id);
        id
    }

    fn find(&mut self, mut label: u32) -> u32 {
        while self.parent[label as usize] != label {
            let parent = self.parent[label as usize];
            self.parent[label as usize] = self.parent[parent as usize];
            label = parent;
        }
        label
    }

    fn union(&mut self, a: u32, b: u32) {
        let root_a = self.find(a);
        let root_b = self.find(b);
        if root_a == root_b {
            return;
        }
        if root_a < root_b {
            self.parent[root_b as usize] = root_a;
        } else {
            self.parent[root_a as usize] = root_b;
        }
    }
}

#[derive(Debug, Clone)]
struct Component {
    size: u64,
    sum_x: f64,
    sum_y: f64,
    bounds: SourceBox,
}

impl Component {
    fn mean_x(&self) -> f64 {
        self.sum_x / self.size as f64
    }

    fn mean_y(&self) -> f64 {
        self.sum_y / self.size as f64
    }
}

/// Labels of the visible pixels (0 = not visible), compacted to `1..=n`,
/// and the per-component statistics indexed by `label - 1`.
fn label_components(image: &RgbaImage) -> (Vec<u32>, Vec<Component>) {
    let (width, height) = image.dimensions();
    let (width_us, height_us) = (width as usize, height as usize);
    let mut labels = vec![0u32; width_us * height_us];
    let mut sets = UnionFind::new();
    let visible = |x: usize, y: usize| image.get_pixel(x as u32, y as u32).0[3] > VISIBLE_ALPHA;
    for y in 0..height_us {
        for x in 0..width_us {
            if !visible(x, y) {
                continue;
            }
            let mut neighbours = [0u32; 4];
            let mut found = 0usize;
            if x > 0 {
                neighbours[found] = labels[y * width_us + x - 1];
                found += 1;
            }
            if y > 0 {
                let above = (y - 1) * width_us;
                if x > 0 {
                    neighbours[found] = labels[above + x - 1];
                    found += 1;
                }
                neighbours[found] = labels[above + x];
                found += 1;
                if x + 1 < width_us {
                    neighbours[found] = labels[above + x + 1];
                    found += 1;
                }
            }
            let mut best = 0u32;
            for &label in &neighbours[..found] {
                if label != 0 && (best == 0 || label < best) {
                    best = label;
                }
            }
            if best == 0 {
                best = sets.make();
            } else {
                for &label in &neighbours[..found] {
                    if label != 0 && label != best {
                        sets.union(label, best);
                    }
                }
            }
            labels[y * width_us + x] = best;
        }
    }
    let mut compact = vec![0u32; sets.parent.len()];
    let mut components: Vec<Component> = Vec::new();
    for y in 0..height_us {
        for x in 0..width_us {
            let index = y * width_us + x;
            let label = labels[index];
            if label == 0 {
                continue;
            }
            let root = sets.find(label);
            if compact[root as usize] == 0 {
                components.push(Component {
                    size: 0,
                    sum_x: 0.0,
                    sum_y: 0.0,
                    bounds: SourceBox {
                        left: x as u32,
                        top: y as u32,
                        right: x as u32 + 1,
                        bottom: y as u32 + 1,
                    },
                });
                compact[root as usize] = components.len() as u32;
            }
            let id = compact[root as usize];
            labels[index] = id;
            let component = &mut components[id as usize - 1];
            component.size += 1;
            component.sum_x += x as f64;
            component.sum_y += y as f64;
            component.bounds.left = component.bounds.left.min(x as u32);
            component.bounds.top = component.bounds.top.min(y as u32);
            component.bounds.right = component.bounds.right.max(x as u32 + 1);
            component.bounds.bottom = component.bounds.bottom.max(y as u32 + 1);
        }
    }
    (labels, components)
}

/// Empty pixels between two half-open boxes along one axis.
fn axis_gap(a_start: u32, a_end: u32, b_start: u32, b_end: u32) -> u32 {
    if a_end <= b_start {
        b_start - a_end
    } else {
        // Zero when the ranges overlap.
        a_start.saturating_sub(b_end)
    }
}

/// Euclidean gap between two boxes; 0 when they touch or overlap.
pub(super) fn box_gap(a: &SourceBox, b: &SourceBox) -> f64 {
    let dx = f64::from(axis_gap(a.left, a.right, b.left, b.right));
    let dy = f64::from(axis_gap(a.top, a.bottom, b.top, b.bottom));
    (dx * dx + dy * dy).sqrt()
}

fn pixel_box(x: u32, y: u32) -> SourceBox {
    SourceBox {
        left: x,
        top: y,
        right: x + 1,
        bottom: y + 1,
    }
}

/// Index of the character whose box is nearest to `target`, with its gap.
fn nearest_character(characters: &[SourceBox], target: &SourceBox) -> (usize, f64) {
    let mut best = (0usize, f64::INFINITY);
    for (index, bounds) in characters.iter().enumerate() {
        let gap = box_gap(bounds, target);
        if gap < best.1 {
            best = (index, gap);
        }
    }
    best
}

pub(super) fn isolate(
    image: &RgbaImage,
    count: usize,
    columns: usize,
) -> Result<Isolated, IsolateFailure> {
    debug_assert!(count > 0 && columns > 0 && count.is_multiple_of(columns));
    debug_assert!(count < 255, "owners are stored in a byte");
    let (width, height) = image.dimensions();
    let (width_us, height_us) = (width as usize, height as usize);
    let (labels, components) = label_components(image);

    // The `count` largest components are the characters.
    let mut ranked: Vec<usize> = (0..components.len()).collect();
    ranked.sort_by(|a, b| components[*b].size.cmp(&components[*a].size).then(a.cmp(b)));
    let threshold = (width_us * height_us) as f64 * MIN_CHARACTER_SHARE / count as f64;
    let full_size = ranked
        .iter()
        .take(count)
        .filter(|index| components[**index].size as f64 >= threshold)
        .count();
    if components.len() < count || full_size < count {
        return Err(IsolateFailure::TooFewCharacters {
            expected: count,
            found: full_size.min(components.len()),
        });
    }
    let mut majors: Vec<usize> = ranked[..count].to_vec();
    if columns == count {
        majors.sort_by(|a, b| components[*a].mean_x().total_cmp(&components[*b].mean_x()));
    } else {
        majors.sort_by(|a, b| components[*a].mean_y().total_cmp(&components[*b].mean_y()));
        for row in majors.chunks_mut(columns) {
            row.sort_by(|a, b| components[*a].mean_x().total_cmp(&components[*b].mean_x()));
        }
    }
    let character_bounds: Vec<SourceBox> = majors.iter().map(|i| components[*i].bounds).collect();

    // Owner per compact label: 0 = unassigned, else character index + 1.
    let mut owner_of_label = vec![0u8; components.len() + 1];
    for (position, component) in majors.iter().enumerate() {
        owner_of_label[component + 1] = position as u8 + 1;
    }
    for (index, component) in components.iter().enumerate() {
        if owner_of_label[index + 1] != 0 {
            continue;
        }
        let (nearest, gap) = nearest_character(&character_bounds, &component.bounds);
        if gap > LOOSE_PIECE_JOIN_PX {
            return Err(IsolateFailure::LoosePiece {
                distance: gap,
                bounds: component.bounds,
            });
        }
        owner_of_label[index + 1] = nearest as u8 + 1;
    }

    // Owner per pixel, and the owned bounds over every pixel with alpha.
    let mut owners = vec![0u8; width_us * height_us];
    let mut owned_bounds: Vec<Option<SourceBox>> = vec![None; count];
    let mut source_alpha = 0u64;
    for y in 0..height_us {
        for x in 0..width_us {
            let index = y * width_us + x;
            let alpha = image.get_pixel(x as u32, y as u32).0[3];
            if alpha == 0 {
                continue;
            }
            source_alpha += u64::from(alpha);
            let label = labels[index];
            let owner = if label != 0 {
                owner_of_label[label as usize]
            } else {
                nearest_character(&character_bounds, &pixel_box(x as u32, y as u32)).0 as u8 + 1
            };
            owners[index] = owner;
            let slot = &mut owned_bounds[owner as usize - 1];
            let (x, y) = (x as u32, y as u32);
            *slot = Some(match slot {
                None => pixel_box(x, y),
                Some(bounds) => SourceBox {
                    left: bounds.left.min(x),
                    top: bounds.top.min(y),
                    right: bounds.right.max(x + 1),
                    bottom: bounds.bottom.max(y + 1),
                },
            });
        }
    }
    let owned_bounds: Vec<SourceBox> = owned_bounds
        .into_iter()
        .map(|bounds| bounds.expect("every character owns its own visible pixels"))
        .collect();

    // Lay the characters out without scaling: one cell each, clear gutters.
    let cell =
        owned_bounds.iter().map(SourceBox::width).max().unwrap_or(0) + 2 * ISOLATED_GUTTER_PX;
    let single_row = columns == count;
    let cell_height = if single_row {
        height
    } else {
        owned_bounds
            .iter()
            .map(SourceBox::height)
            .max()
            .unwrap_or(0)
            + 2 * ISOLATED_GUTTER_PX
    };
    let rows = (count / columns) as u32;
    let mut result = RgbaImage::new(cell * columns as u32, cell_height * rows);
    let mut copied_alpha = 0u64;
    for (index, bounds) in owned_bounds.iter().enumerate() {
        let owner = index as u8 + 1;
        let x0 = (index % columns) as u32 * cell + (cell - bounds.width()) / 2;
        let y0 = if single_row {
            bounds.top
        } else {
            (index / columns) as u32 * cell_height + (cell_height - bounds.height()) / 2
        };
        for y in bounds.top..bounds.bottom {
            for x in bounds.left..bounds.right {
                if owners[y as usize * width_us + x as usize] != owner {
                    continue;
                }
                let pixel = *image.get_pixel(x, y);
                copied_alpha += u64::from(pixel.0[3]);
                result.put_pixel(x0 + x - bounds.left, y0 + y - bounds.top, pixel);
            }
        }
    }
    if copied_alpha != source_alpha {
        return Err(IsolateFailure::PixelsLost);
    }
    Ok(Isolated {
        image: result,
        owned_bounds,
    })
}

#[cfg(test)]
pub(super) fn alpha_sum(image: &RgbaImage) -> u64 {
    image.pixels().map(|pixel| u64::from(pixel.0[3])).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn fill(image: &mut RgbaImage, left: u32, top: u32, right: u32, bottom: u32, color: Rgba<u8>) {
        for y in top..bottom {
            for x in left..right {
                image.put_pixel(x, y, color);
            }
        }
    }

    const RED: Rgba<u8> = Rgba([220, 40, 40, 255]);
    const BLUE: Rgba<u8> = Rgba([40, 40, 220, 255]);

    /// Two blocks whose horizontal extents overlap: the red one has an arm
    /// reaching over the blue one's column range without touching it.
    fn overlapping_pair() -> RgbaImage {
        let mut image = RgbaImage::new(200, 100);
        fill(&mut image, 20, 20, 60, 90, RED);
        fill(&mut image, 60, 30, 150, 36, RED); // the arm, above the blue body
        fill(&mut image, 110, 50, 170, 90, BLUE);
        image
    }

    #[test]
    fn splits_characters_with_overlapping_extents_without_losing_alpha() {
        let image = overlapping_pair();
        let isolated = isolate(&image, 2, 2).unwrap();
        assert_eq!(
            isolated.owned_bounds,
            vec![
                SourceBox {
                    left: 20,
                    top: 20,
                    right: 150,
                    bottom: 90
                },
                SourceBox {
                    left: 110,
                    top: 50,
                    right: 170,
                    bottom: 90
                },
            ]
        );
        // cell = widest owned box (130) + 48; one row keeps the source height.
        assert_eq!(isolated.image.dimensions(), (356, 100));
        assert_eq!(alpha_sum(&isolated.image), alpha_sum(&image));
        // Red sits in the first cell, blue in the second, at their source rows.
        assert_eq!(*isolated.image.get_pixel(24 + 30, 60), RED);
        assert_eq!(*isolated.image.get_pixel(178 + 59 + 10, 60), BLUE);
        // No blue pixel leaked into the first cell.
        assert!(
            (0..178).all(|x| (0..100).all(|y| *isolated.image.get_pixel(x, y) != BLUE)),
            "blue pixels must stay in their own cell"
        );
    }

    #[test]
    fn a_detached_sparkle_joins_the_nearest_character() {
        let mut image = overlapping_pair();
        // A sparkle 10 px right of the blue block.
        fill(&mut image, 180, 60, 184, 64, Rgba([255, 255, 0, 255]));
        let isolated = isolate(&image, 2, 2).unwrap();
        assert_eq!(
            isolated.owned_bounds[1],
            SourceBox {
                left: 110,
                top: 50,
                right: 184,
                bottom: 90
            }
        );
        assert_eq!(alpha_sum(&isolated.image), alpha_sum(&image));
    }

    #[test]
    fn faint_pixels_follow_the_nearest_character_so_no_alpha_is_lost() {
        let mut image = overlapping_pair();
        // 5 px below the blue block and 10 px right of the red one: blue owns it.
        image.put_pixel(160, 95, Rgba([0, 0, 0, 9]));
        let isolated = isolate(&image, 2, 2).unwrap();
        assert_eq!(alpha_sum(&isolated.image), alpha_sum(&image));
        assert_eq!(isolated.owned_bounds[1].bottom, 96);
        assert_eq!(isolated.owned_bounds[0].bottom, 90);
    }

    #[test]
    fn a_stray_blob_far_from_every_character_fails() {
        let mut image = overlapping_pair();
        fill(&mut image, 180, 2, 190, 10, Rgba([0, 255, 0, 255]));
        let error = isolate(&image, 2, 2).unwrap_err();
        match error {
            IsolateFailure::LoosePiece { distance, bounds } => {
                assert_eq!(
                    bounds,
                    SourceBox {
                        left: 180,
                        top: 2,
                        right: 190,
                        bottom: 10
                    }
                );
                // Nearest is the red box: 30 px across, 10 px down.
                assert!((distance - 31.62).abs() < 0.01, "gap was {distance}");
            }
            other => panic!("expected a loose piece, got {other:?}"),
        }
    }

    #[test]
    fn touching_characters_count_as_one_and_fail() {
        let mut image = RgbaImage::new(200, 100);
        fill(&mut image, 20, 20, 100, 90, RED);
        fill(&mut image, 100, 20, 180, 90, BLUE);
        assert_eq!(
            isolate(&image, 2, 2),
            Err(IsolateFailure::TooFewCharacters {
                expected: 2,
                found: 1
            })
        );
    }

    #[test]
    fn a_tiny_component_is_not_a_character() {
        let mut image = RgbaImage::new(200, 100);
        fill(&mut image, 20, 20, 100, 90, RED);
        fill(&mut image, 150, 40, 154, 44, BLUE);
        assert_eq!(
            isolate(&image, 2, 2),
            Err(IsolateFailure::TooFewCharacters {
                expected: 2,
                found: 1
            })
        );
    }

    #[test]
    fn multi_row_sheets_order_by_row_then_column_and_centre_each_cell() {
        let mut image = RgbaImage::new(200, 200);
        fill(&mut image, 10, 10, 60, 60, RED); // top-left
        fill(&mut image, 120, 20, 170, 70, BLUE); // top-right
        fill(&mut image, 130, 120, 180, 190, Rgba([0, 200, 0, 255])); // bottom-right
        fill(&mut image, 20, 130, 70, 180, Rgba([200, 200, 0, 255])); // bottom-left
        let isolated = isolate(&image, 4, 2).unwrap();
        assert_eq!(isolated.owned_bounds[0].left, 10);
        assert_eq!(isolated.owned_bounds[1].left, 120);
        assert_eq!(isolated.owned_bounds[2].left, 20);
        assert_eq!(isolated.owned_bounds[3].left, 130);
        // cell 98 wide (50 + 48), cell height 118 (70 + 48).
        assert_eq!(isolated.image.dimensions(), (196, 236));
        assert_eq!(alpha_sum(&isolated.image), alpha_sum(&image));
    }

    #[test]
    fn diagonal_neighbours_are_connected() {
        let mut image = RgbaImage::new(60, 60);
        for i in 0..40u32 {
            image.put_pixel(10 + i, 10 + i, RED);
        }
        let (_, components) = label_components(&image);
        assert_eq!(components.len(), 1);
        assert_eq!(components[0].size, 40);
    }
}
