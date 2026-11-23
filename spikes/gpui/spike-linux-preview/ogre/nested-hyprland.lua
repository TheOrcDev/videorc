-- Plan 260 S0.3: a nested, isolated Hyprland for the GPUI preview spike.
-- Runs as a window inside the owner's (locked) session; its own outputs,
-- its own Xwayland, its own sockets. Screenshots with grim against its
-- WAYLAND_DISPLAY.
hl.monitor({ output = "", mode = "1920x1080@60", position = "0x0", scale = 1 })
hl.config({
  general = { gaps_in = 0, gaps_out = 0, border_size = 0, layout = "dwindle" },
  decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },
  animations = { enabled = false },
  misc = {
    disable_hyprland_logo = true,
    disable_splash_rendering = true,
    background_color = "rgb(3a2a4a)",
  },
})
hl.window_rule({ match = { class = "videorc-s0-3-spike" }, float = true, size = { 1650, 1000 }, center = true })
