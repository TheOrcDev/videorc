//! S0.2a's macOS proof: an in-process IOSurface with a known pattern is
//! imported, drawn into an RGBA8 target through a trivial shader and read
//! back; then the IOSurface is rewritten after the import and the texture
//! shows the change, which proves the import shares memory.

#![cfg(target_os = "macos")]

use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFType};
use objc2_io_surface::{
    IOSurfaceLockOptions, IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceHeight,
    kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use videorc_gpu_import::{IMPORTED_TEXTURE_USAGES, ImportError, import_iosurface};

const WIDTH: u32 = 16;
const HEIGHT: u32 = 8;
const FOURCC_BGRA: i32 = 0x4247_5241;
const FOURCC_RGBA: i32 = 0x5247_4241;

const SHADER: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;

struct VertexOut { @builtin(position) position: vec4<f32> }

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOut {
    var corners = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return VertexOut(vec4<f32>(corners[index], 0.0, 1.0));
}

@fragment
fn fragment(input: VertexOut) -> @location(0) vec4<f32> {
    return textureLoad(source, vec2<i32>(input.position.xy), 0);
}
"#;

/// A pixel in memory order: for a BGRA surface `[b, g, r, a]`, for an RGBA
/// surface `[r, g, b, a]`.
type Pattern = fn(u32, u32) -> [u8; 4];

fn bgra_pattern_a(x: u32, y: u32) -> [u8; 4] {
    [(x * 16) as u8, (y * 32) as u8, 0x80, 0xff]
}

fn bgra_pattern_b(x: u32, y: u32) -> [u8; 4] {
    [0x10, (x * 16) as u8, (y * 32) as u8, 0xff]
}

fn rgba_pattern(x: u32, y: u32) -> [u8; 4] {
    [(x * 16) as u8, 0x40, (y * 32) as u8, 0xff]
}

/// The RGBA bytes a readback of the RGBA8 target holds for a pixel the
/// pattern wrote in memory order.
fn expected_rgba(bgra: bool, pixel: [u8; 4]) -> [u8; 4] {
    if bgra {
        [pixel[2], pixel[1], pixel[0], pixel[3]]
    } else {
        pixel
    }
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    target: wgpu::Texture,
    readback: wgpu::Buffer,
}

impl Gpu {
    fn new() -> Self {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .expect("a Metal adapter: every Mac has one");
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .expect("a wgpu device on the Metal adapter");

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("copy"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("source"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("copy"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("copy"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("target"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(padded_bytes_per_row() * HEIGHT),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            target,
            readback,
        }
    }

    /// Draws `source` into the RGBA8 target and returns its pixels row by
    /// row, four bytes each, in RGBA order.
    fn draw_and_read(&self, source: &wgpu::Texture) -> Vec<[u8; 4]> {
        let view = source.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("source"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        let target_view = self
            .target
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("copy"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("copy"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            self.target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row()),
                    rows_per_image: None,
                },
            },
            self.target.size(),
        );
        self.queue.submit([encoder.finish()]);

        let slice = self.readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| {
            result.expect("the readback buffer maps")
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("the device finishes the draw");
        let pixels = {
            let bytes = slice
                .get_mapped_range()
                .expect("the mapped readback range is readable");
            let row_stride = padded_bytes_per_row() as usize;
            (0..HEIGHT as usize)
                .flat_map(|y| (0..WIDTH as usize).map(move |x| y * row_stride + x * 4))
                .map(|at| [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                .collect::<Vec<_>>()
        };
        self.readback.unmap();
        pixels
    }
}

fn padded_bytes_per_row() -> u32 {
    let unpadded = WIDTH * 4;
    unpadded.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

/// Creates a 32-bit-per-pixel IOSurface of `fourcc` in this process.
fn make_surface(width: u32, height: u32, fourcc: i32) -> CFRetained<IOSurfaceRef> {
    let width = CFNumber::new_i32(width as i32);
    let height = CFNumber::new_i32(height as i32);
    let bytes_per_element = CFNumber::new_i32(4);
    let pixel_format = CFNumber::new_i32(fourcc);
    // SAFETY: the keys are IOSurface's own exported constants.
    let (width_key, height_key, bytes_per_element_key, pixel_format_key) = unsafe {
        (
            kIOSurfaceWidth,
            kIOSurfaceHeight,
            kIOSurfaceBytesPerElement,
            kIOSurfacePixelFormat,
        )
    };
    let properties = CFDictionary::<CFType, CFType>::from_slices(
        &[
            width_key.as_ref(),
            height_key.as_ref(),
            bytes_per_element_key.as_ref(),
            pixel_format_key.as_ref(),
        ],
        &[
            width.as_ref(),
            height.as_ref(),
            bytes_per_element.as_ref(),
            pixel_format.as_ref(),
        ],
    );
    let properties: &CFDictionary = properties.as_ref();
    // SAFETY: every value is a CFNumber, which is what these keys take.
    unsafe { IOSurfaceRef::new(properties) }.expect("IOSurfaceCreate")
}

/// Writes `pattern` into every pixel of `surface` from the CPU.
fn fill(surface: &IOSurfaceRef, pattern: Pattern) {
    // SAFETY: a lock with a null seed pointer; unlocked below on the same
    // thread before the surface is read by the GPU.
    let locked = unsafe { surface.lock(IOSurfaceLockOptions::empty(), std::ptr::null_mut()) };
    assert_eq!(locked, 0, "IOSurfaceLock");
    let base = surface.base_address().as_ptr().cast::<u8>();
    let bytes_per_row = surface.bytes_per_row();
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let pixel = pattern(x, y);
            let offset = y as usize * bytes_per_row + x as usize * 4;
            // SAFETY: the surface is locked and `offset + 4` is inside its
            // `bytes_per_row * height` allocation.
            unsafe { std::ptr::copy_nonoverlapping(pixel.as_ptr(), base.add(offset), 4) };
        }
    }
    // SAFETY: matches the lock above.
    let unlocked = unsafe { surface.unlock(IOSurfaceLockOptions::empty(), std::ptr::null_mut()) };
    assert_eq!(unlocked, 0, "IOSurfaceUnlock");
}

fn assert_pixels(pixels: &[[u8; 4]], bgra: bool, pattern: Pattern, what: &str) {
    assert_eq!(pixels.len(), (WIDTH * HEIGHT) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let expected = expected_rgba(bgra, pattern(x, y));
            let actual = pixels[(y * WIDTH + x) as usize];
            assert_eq!(actual, expected, "{what}: pixel ({x}, {y})");
        }
    }
}

#[test]
fn bgra_iosurface_imports_and_draws_its_pattern() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_BGRA);
    fill(&surface, bgra_pattern_a);

    let texture = import_iosurface(
        &gpu.device,
        surface.id(),
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Bgra8Unorm,
    )
    .expect("the BGRA IOSurface imports");
    assert_eq!(texture.format(), wgpu::TextureFormat::Bgra8Unorm);
    assert_eq!(texture.width(), WIDTH);
    assert_eq!(texture.height(), HEIGHT);
    assert_eq!(texture.usage(), IMPORTED_TEXTURE_USAGES);

    let pixels = gpu.draw_and_read(&texture);
    assert_pixels(&pixels, true, bgra_pattern_a, "BGRA pattern A");
}

#[test]
fn imported_texture_shares_the_iosurface_memory() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_BGRA);
    fill(&surface, bgra_pattern_a);

    let texture = import_iosurface(
        &gpu.device,
        surface.id(),
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Bgra8Unorm,
    )
    .expect("the BGRA IOSurface imports");
    let before = gpu.draw_and_read(&texture);
    assert_pixels(&before, true, bgra_pattern_a, "before the rewrite");

    // Written after the import, with no second import: a copy would still
    // show pattern A.
    fill(&surface, bgra_pattern_b);
    let after = gpu.draw_and_read(&texture);
    assert_pixels(&after, true, bgra_pattern_b, "after the rewrite");
}

#[test]
fn rgba_iosurface_imports_too() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_RGBA);
    fill(&surface, rgba_pattern);

    let texture = import_iosurface(
        &gpu.device,
        surface.id(),
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Rgba8Unorm,
    )
    .expect("the RGBA IOSurface imports");
    let pixels = gpu.draw_and_read(&texture);
    assert_pixels(&pixels, false, rgba_pattern, "RGBA pattern");
}

#[test]
fn the_texture_outlives_the_producers_reference() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_BGRA);
    fill(&surface, bgra_pattern_a);
    let id = surface.id();

    let texture = import_iosurface(
        &gpu.device,
        id,
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Bgra8Unorm,
    )
    .expect("the BGRA IOSurface imports");
    drop(surface);

    // The import retained the surface: it is still lookupable and still
    // holds the pattern.
    let again = IOSurfaceRef::lookup(id).expect("the imported surface stays alive");
    assert_eq!(again.width(), WIDTH as usize);
    let pixels = gpu.draw_and_read(&texture);
    assert_pixels(&pixels, true, bgra_pattern_a, "after the producer let go");

    drop(again);
    drop(texture);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("the device drains");
    // wgpu releases the hal texture, and with it the keep-alive, once the
    // queue is done with it; a few polls are enough for an idle queue.
    for _ in 0..10 {
        if IOSurfaceRef::lookup(id).is_none() {
            return;
        }
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("the device drains");
    }
    panic!("the IOSurface {id} is still lookupable after its texture was dropped");
}

#[test]
fn a_stale_frame_size_is_refused_before_metal_sees_it() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_BGRA);
    let error = import_iosurface(
        &gpu.device,
        surface.id(),
        WIDTH * 2,
        HEIGHT,
        wgpu::TextureFormat::Bgra8Unorm,
    )
    .expect_err("a wrong size is refused");
    assert_eq!(
        error,
        ImportError::GeometryMismatch {
            expected: (WIDTH * 2, HEIGHT),
            actual: (WIDTH, HEIGHT),
        }
    );
}

#[test]
fn a_surface_of_another_format_is_refused() {
    let gpu = Gpu::new();
    let surface = make_surface(WIDTH, HEIGHT, FOURCC_BGRA);
    let error = import_iosurface(
        &gpu.device,
        surface.id(),
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Rgba8Unorm,
    )
    .expect_err("a BGRA surface is not an RGBA texture");
    assert_eq!(
        error,
        ImportError::FormatMismatch {
            requested: wgpu::TextureFormat::Rgba8Unorm,
            actual: "pixel format 'BGRA'".to_string(),
        }
    );
}

#[test]
fn an_unknown_id_is_reported() {
    let gpu = Gpu::new();
    let error = import_iosurface(
        &gpu.device,
        u32::MAX - 7,
        WIDTH,
        HEIGHT,
        wgpu::TextureFormat::Bgra8Unorm,
    )
    .expect_err("no surface has this id");
    assert_eq!(
        error,
        ImportError::SurfaceNotFound {
            iosurface_id: u32::MAX - 7
        }
    );
}
