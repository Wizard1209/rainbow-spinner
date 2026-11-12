-- rainbow-spinner for WezTerm: draws the holo word as a picture.
--
-- WezTerm shows kitty pictures placed at the cursor, but not the kind Claude
-- Code sends, so the mod leaves blank braille cells where the word goes and
-- writes its frames, stacked into one sheet, to a file; this module, running
-- inside WezTerm, hands the sheet to WezTerm once per word, finds those cells
-- on the pane's screen and places the running frame's band of the sheet over
-- them. Nothing is written into Claude Code's own output: the picture goes in
-- through pane:inject_output, between the program's whole sequences.
--
-- In wezterm.lua, with this file next to it:
--   dofile(wezterm.config_dir .. '/rainbow-spinner.lua').apply(config)

local wezterm = require 'wezterm'

local M = {}

local MARK = '\u{2800}'
local ID = 5395201 -- the kitty image id the word is drawn under
-- Seconds to wait between ticks: while a line is drawn (a frame lasts 40 ms;
-- Windows stretches this wait to about 31 ms) / otherwise.
local FAST, SLOW = 0.02, 0.5
local STALE_MS = 1500 -- a state the mod has not changed for this long is a line that ended
local GONE_MS = 60000 -- and for this long, one that draws no more: its state and ack files go
-- Takes the picture away and frees the sheet WezTerm holds.
local DELETE = '\x1b_Ga=d,d=I,i=' .. ID .. ',q=2\x1b\\'

local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local function base64(s)
  return (s:gsub('..?.?', function(x)
    local a, b, c = x:byte(1, 3)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local out = ''
    for i = 1, #x + 1 do
      local k = n // 64 ^ (4 - i) % 64
      out = out .. B64:sub(k + 1, k + 1)
    end
    return out .. ('='):rep(3 - #x)
  end))
end

local function now_ms()
  return tonumber(wezterm.time.now():format '%s%3f')
end

local function read(path)
  local f = io.open(path, 'r')
  if not f then return nil end
  local s = f:read 'a'
  f:close()
  return s
end

local function write(path, s)
  local f = io.open(path, 'w')
  if not f then return end
  f:write(s)
  f:close()
end

-- Cells a string takes: wide East Asian letters and emoji two, combining marks none.
local function width(s)
  local n = 0
  for _, c in utf8.codes(s) do
    if (c >= 0x300 and c <= 0x36f) or c == 0x200d or (c >= 0xfe00 and c <= 0xfe0f) then
    elseif (c >= 0x1100 and c <= 0x115f) or (c >= 0x2e80 and c <= 0xa4cf) or (c >= 0xac00 and c <= 0xd7a3)
      or (c >= 0xf900 and c <= 0xfaff) or (c >= 0xfe30 and c <= 0xfe4f) or (c >= 0xff00 and c <= 0xff60)
      or (c >= 0xffe0 and c <= 0xffe6) or (c >= 0x1f300 and c <= 0x1faff) or (c >= 0x20000 and c <= 0x3fffd) then
      n = n + 2
    else
      n = n + 1
    end
  end
  return n
end

-- The column of the last run of exactly `cells` marks in a row's text, or nil.
local function run_in(line, cells)
  local run, from, found = MARK:rep(cells), 1, nil
  while true do
    local a, b = line:find(run, from, true)
    if not a then break end
    if line:sub(a - #MARK, a - 1) ~= MARK and line:sub(b + 1, b + #MARK) ~= MARK then found = a end
    from = a + 1
  end
  return found and width(line:sub(1, found - 1))
end

-- The run on the pane's screen as a 0-based row and column: in the row it was
-- last found in, else the lowest. Row by row: get_lines_as_text drops blank
-- rows, which would shift every row below them.
--
-- get_text_from_region leaves out the region's end row in WezTerm builds up
-- to 20240203 and takes it in in builds from 2025 on. A row's text is
-- therefore read as that of the row and the one below it, less what the row
-- below gives alone: its own text where the end row is taken in, nothing
-- where it is left out. The program can write between the two reads; a row
-- whose text then does not end in the row below's is passed over this time.
local function find(pane, cells, last_row)
  local dims = pane:get_dimensions()
  local function at(y)
    local top = dims.physical_top + y
    local two = pane:get_text_from_region(0, top, dims.cols, top + 1)
    local below = pane:get_text_from_region(0, top + 1, dims.cols, top + 1)
    if two:sub(#two - #below + 1) ~= below then return end
    return run_in(two:sub(1, #two - #below), cells)
  end
  if last_row and last_row < dims.viewport_rows then
    local col = at(last_row)
    if col then return last_row, col end
  end
  for y = dims.viewport_rows - 1, 0, -1 do
    local col = y ~= last_row and at(y)
    if col then return y, col end
  end
end

-- The pane the state names, and where in it the line is.
local function locate(state, cells, line)
  local ok, pane = pcall(wezterm.mux.get_pane, tonumber(state.pane))
  if not (ok and pane) then return end
  local row, col = find(pane, cells, line.row)
  if row then return pane, row, col end
end

-- One state file per pane whose session draws: `key=value` lines, `beat`
-- last; see hooks/core/wezterm.ts. A read that does not end in `beat` is one
-- caught halfway through the mod's write, and is skipped.
local function parse(s)
  if not (s and s:match '\nbeat=%d+\n$') then return end
  local t = {}
  for k, v in s:gmatch '(%w+)=([^\n]*)' do t[k] = v end
  return t
end

local lines = {} -- by state file: { beat, seen (our ms when beat last changed or was first read), pane, row, shown (the sheet WezTerm holds) }

-- One line's tick: whether it is drawn, so the module ticks fast.
local function draw(dir, name, state, t, tick)
  local line = lines[name]
  if not line then
    -- First seen counts as a change: the mod has just written it, or this
    -- module has just started.
    line = { beat = state.beat, seen = t }
    lines[name] = line
  elseif line.beat ~= state.beat then
    line.beat, line.seen = state.beat, t
  end
  if t - line.seen >= GONE_MS then
    -- The mod writes the state anew at each word: nothing waits for these
    -- files between words. The sheets stay; the mod reuses them.
    pcall(os.remove, name)
    pcall(os.remove, (name:gsub('%.state$', '.ack')))
    lines[name] = nil
    return false
  end
  local live = t - line.seen < STALE_MS
  local want = live and state.sheet ~= '' and (state.sheet .. '/' .. state.made .. '/' .. state.cells) or nil
  if line.shown and line.shown ~= want then
    -- A line that ended, changed word or width loses its picture at once.
    pcall(function() line.pane:inject_output(DELETE) end)
    line.shown = nil
  end
  if not want then return live end
  local cells = tonumber(state.cells)
  local pane, row, col = locate(state, cells, line)
  if not pane then return true end
  -- The sheet goes to WezTerm once, which reads and decodes it then; each
  -- tick places one frame's band of it, and a placement under the same image
  -- id replaces the one before. WezTerm takes a placement off the rows it was
  -- made on, so a placement whose cells the program has scrolled elsewhere
  -- stays there; without a placement id, the text the program writes over
  -- those cells takes it away.
  local sheet = ''
  if line.shown ~= want then
    sheet = '\x1b_Ga=t,t=f,f=100,i=' .. ID .. ',q=2;' .. base64(dir .. '/' .. state.sheet) .. '\x1b\\'
  end
  local h = tonumber(state.height)
  local k = math.floor(t / tonumber(state.frameMs)) % tonumber(state.count)
  pane:inject_output(
    sheet .. '\x1b7\x1b[' .. (row + 1) .. ';' .. (col + 1) .. 'H'
      .. '\x1b_Ga=p,i=' .. ID .. ',x=0,y=' .. (k * h) .. ',w=' .. state.width .. ',h=' .. h
      .. ',c=' .. cells .. ',r=1,C=1,q=2\x1b\\'
      .. '\x1b8'
  )
  line.pane, line.row, line.shown = pane, row, want
  write(name:gsub('%.state$', '.ack'), tick)
  return true
end

-- The state files of the panes WezTerm has, named after the panes' ids, which
-- are asked of the mux at most once a slow tick. On Windows WezTerm keeps
-- native memory at each read_dir, so the module leaves WezTerm's file calls
-- alone and reads with io.
local listed, listed_at = {}, nil
local function states(dir, t)
  if listed_at and t - listed_at < SLOW * 1000 then return listed end
  local names = {}
  for _, window in ipairs(wezterm.mux.all_windows()) do
    for _, tab in ipairs(window:tabs()) do
      for _, pane in ipairs(tab:panes()) do names[#names + 1] = dir .. '/pane-' .. pane:pane_id() .. '.state' end
    end
  end
  listed, listed_at = names, t
  return names
end

local function tick(dir)
  local t, busy = now_ms(), false
  local stamp = tostring(t)
  for _, name in ipairs(states(dir, t)) do
    local state = parse(read(name))
    if state then busy = draw(dir, name, state, t, stamp) or busy end
  end
  -- Written last: a change of `alive` tells the mod a whole tick has read its state.
  write(dir .. '/alive', stamp)
  return busy
end

-- WSLENV with the entries that bring the folder (as a WSL path) and the pane
-- into WSL, added to what is there.
local function wslenv(have)
  local out, names = {}, {}
  for entry in (have or ''):gmatch '[^:]+' do
    out[#out + 1] = entry
    names[entry:match '^[^/]*'] = true
  end
  for _, entry in ipairs { 'RAINBOW_SPINNER_WEZTERM_DIR/p', 'WEZTERM_PANE' } do
    if not names[entry:match '^[^/]*'] then out[#out + 1] = entry end
  end
  return table.concat(out, ':')
end

-- opts.dir: the folder the mod and the module meet in; it must not be the
-- folder of wezterm.lua or one directly inside it, where WezTerm reloads the
-- config when files are created.
function M.apply(config, opts)
  local windows = wezterm.target_triple:find 'windows' ~= nil
  local dir = (opts or {}).dir or table.concat({ wezterm.home_dir, '.cache', 'rainbow-spinner', 'wezterm' }, windows and '\\' or '/')
  local env = config.set_environment_variables or {}
  env.RAINBOW_SPINNER_WEZTERM_DIR = dir
  if windows then env.WSLENV = wslenv(env.WSLENV or os.getenv 'WSLENV') end
  config.set_environment_variables = env
  -- The config is evaluated more than once, each in a Lua state of its own,
  -- and only some states live on: the loop starts from an event, which only
  -- a live state receives, once per state. It is one call_after, which keeps
  -- each function it is handed for as long as the state lives, and it waits
  -- with sleep_ms; a reload's new state takes over and this loop ends.
  local started = false
  wezterm.on('update-status', function()
    if started then return end
    started = true
    local me = {} -- held by the loop, so no other state's table has its address
    wezterm.GLOBAL.rainbow_spinner_loop = tostring(me)
    wezterm.time.call_after(0, function()
      while wezterm.GLOBAL.rainbow_spinner_loop == tostring(me) do
        local ok, busy = pcall(tick, dir)
        if not ok then wezterm.log_error('rainbow-spinner: ' .. tostring(busy)) end
        wezterm.sleep_ms(ok and busy and FAST * 1000 or SLOW * 1000)
      end
    end)
  end)
  return config
end

return M
