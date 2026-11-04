-- Plan 179: the Linux lab display, a Hyprland headless output. The twin of
-- hyprland.videorc-lab.conf for a Hyprland configured in Lua (hyprland.lua,
-- Omarchy since Hyprland 0.56).
--
-- Put it next to hyprland.lua and require it after the personal overrides:
--
--   cp config/live-lab/linux/hyprland.videorc-lab.lua ~/.config/hypr/videorc_lab.lua
--   require("hypr.videorc_lab")      -- in ~/.config/hypr/hyprland.lua
--
-- then `hyprctl reload`, and tell the lab its name once:
--
--   pnpm live:hookup --lab-display videorc-lab
--
-- Placed far to the right so the pointer never wanders onto it, 1920x1080 at
-- 30 Hz like the lab stream, scale 1 (the card's markers are pixel exact). A
-- monitors.lua that places every output "auto" can move the real screen next
-- to it; pin the real screen at 0x0 with its own hl.monitor line if it does.

hl.monitor({ output = "videorc-lab", mode = "1920x1080@30", position = "20000x0", scale = 1 })

-- The new output may take focus (the doctor WARNs). Hand it back to the real
-- screen by name after creating it, in the Lua dispatch form:
--   ...; hyprctl dispatch 'hl.dsp.focus({ monitor = "eDP-1" })'
hl.on("hyprland.start", function()
  hl.exec_cmd("hyprctl output create headless videorc-lab")
end)
