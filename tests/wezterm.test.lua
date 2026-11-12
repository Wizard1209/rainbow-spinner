-- The WezTerm module against a WezTerm made of tables and files kept in
-- memory. From the repo's root, with Lua 5.4: lua tests/wezterm.test.lua

local files, clock = {}, 0

io.open = function(path, mode)
  if mode == 'w' then
    local parent = path:match '^(.*)/[^/]*$'
    if not files[parent] then return nil end
    local buf = {}
    return { write = function(_, s) buf[#buf + 1] = s end, close = function() files[path] = table.concat(buf) end }
  end
  local s = files[path]
  if type(s) ~= 'string' then return nil end
  return { read = function() return s end, close = function() end }
end

os.remove = function(path)
  if type(files[path]) ~= 'string' then return nil, path .. ': no such file' end
  files[path] = nil
  return true
end

local env = {}
os.getenv = function(k) return env[k] end

-- Whether get_text_from_region takes in the region's end row, as WezTerm
-- builds from 2025 on do, or leaves it out, as builds up to 20240203 do.
-- Either way each row is trimmed at its end, and a newline goes before each
-- row of the region once the text has something in it, a left-out end row too.
local end_row_in = true

-- A pane: its screen's rows as text, from stable row 100 on, and what was
-- injected into it.
local function pane(id, rows)
  local p = { id = id, rows = rows, out = {} }
  function p:pane_id() return self.id end
  function p:get_dimensions() return { physical_top = 100, viewport_rows = #self.rows, cols = 80 } end
  function p:get_text_from_region(_, top, _, bottom)
    local s = ''
    for y = top, bottom do
      local row = self.rows[y - 100 + 1]
      if row then
        if s ~= '' then s = s .. '\n' end
        if y < bottom or end_row_in then s = s .. (row:gsub('%s+$', '')) end
      end
    end
    return s
  end
  function p:inject_output(s) self.out[#self.out + 1] = s end
  return p
end

-- WezTerm's timers: call_after starts its function as a coroutine, which
-- sleep_ms suspends until the next `tick` resumes it. `panes` are the panes
-- get_pane finds; `listed` (default: `panes`) those the mux lists in its one
-- window and tab, and `listings` counts how often it is asked for them;
-- `timers` counts the calls to call_after.
local W
local function module(triple, panes, listed)
  W = {
    target_triple = triple or 'aarch64-apple-darwin',
    home_dir = triple and triple:find 'windows' and 'C:\\Users\\u' or '/home/u',
    handlers = {},
    GLOBAL = {},
    listings = 0,
    time = {
      now = function() return { format = function() return tostring(clock) end } end,
      call_after = function(_, fn) W.timers = (W.timers or 0) + 1; W.loop = coroutine.create(fn) end,
    },
    sleep_ms = function(ms) W.slept = ms; coroutine.yield() end,
    mux = {
      get_pane = function(id)
        for _, p in ipairs(panes or {}) do
          if p.id == id then return p end
        end
        error 'no pane'
      end,
      all_windows = function()
        W.listings = W.listings + 1
        local tab = { panes = function() return listed or panes or {} end }
        return { { tabs = function() return { tab } end } }
      end,
    },
    log_error = function(s) error(s) end,
  }
  function W.on(event, fn) W.handlers[event] = fn end
  package.loaded.wezterm = W
  return dofile 'wezterm/rainbow-spinner.lua'
end

local passed = 0
local function test(name, body)
  files, clock, env = {}, 0, {}
  local ok, err = pcall(body)
  if not ok then error(name .. ': ' .. tostring(err), 0) end
  passed = passed + 1
end
-- A test that goes through find(), once with the end row taken in and once
-- with it left out.
local function both(name, body)
  for _, taken in ipairs { true, false } do
    end_row_in = taken
    test(name .. (taken and ' (end row taken in)' or ' (end row left out)'), body)
  end
  end_row_in = true
end
local function eq(got, want)
  if got ~= want then error(('got %s, want %s'):format(tostring(got), tostring(want)), 2) end
end

local MARK = '\u{2800}'
local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local function base64(s) -- plain, for the expected text
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    for j = 1, 4 do
      out[#out + 1] = j <= #s - i + 2 and B64:sub(n // 64 ^ (4 - j) % 64 + 1, n // 64 ^ (4 - j) % 64 + 1) or '='
    end
  end
  return table.concat(out)
end
local DIR = '/x'
local function state(t) -- the mod's state text
  return ('pane=%s\ncells=%d\nframeMs=40\ncount=43\nwidth=%d\nheight=48\nsheet=%s\nmade=%d\nbeat=%d\n'):format(
    t.pane or '', t.cells, t.cells * 25, t.frames and (t.frames .. '.png') or '', t.made or 1, t.beat)
end
local function resume()
  local ok, err = coroutine.resume(W.loop)
  if not ok then error(err, 0) end
end
local function start(config)
  local M = module(nil, config.panes, config.listed)
  M.apply({}, { dir = DIR })
  W.handlers['update-status']()
  resume()
end
local function tick(ms)
  clock = clock + (ms or 40)
  resume()
end
local function drawn(p) -- what went into a pane: `sheet` sent, a frame placed at row,col, `delete`
  local at = {}
  for _, s in ipairs(p.out) do
    local sheet, row, col = s:find '\x1b_Ga=t,', s:match '\x1b7\x1b%[(%d+);(%d+)H\x1b_Ga=p'
    if sheet then at[#at + 1] = 'sheet' end
    if row then
      at[#at + 1] = row .. ',' .. col
    elseif s:find 'a=d' then
      at[#at + 1] = 'delete'
    elseif not sheet then
      at[#at + 1] = s
    end
  end
  return table.concat(at, ' ')
end

-- Set-up: the folder and, on Windows, WSLENV.

test('apply names the folder to what WezTerm starts, and leaves WSLENV alone off Windows', function()
  local M = module 'aarch64-apple-darwin'
  local config = M.apply { set_environment_variables = { A = '1' } }
  eq(config.set_environment_variables.RAINBOW_SPINNER_WEZTERM_DIR, '/home/u/.cache/rainbow-spinner/wezterm')
  eq(config.set_environment_variables.A, '1')
  eq(config.set_environment_variables.WSLENV, nil)
  eq(M.apply({}, { dir = '/d' }).set_environment_variables.RAINBOW_SPINNER_WEZTERM_DIR, '/d')
end)

test('on Windows, WSLENV brings the folder as a WSL path and the pane, added to what is there', function()
  local M = module 'x86_64-pc-windows-msvc'
  eq(M.apply({}).set_environment_variables.WSLENV, 'RAINBOW_SPINNER_WEZTERM_DIR/p:WEZTERM_PANE')
  eq(M.apply({}).set_environment_variables.RAINBOW_SPINNER_WEZTERM_DIR, 'C:\\Users\\u\\.cache\\rainbow-spinner\\wezterm')
  env.WSLENV = 'USERPROFILE/up:WEZTERM_PANE/u'
  eq(M.apply({}).set_environment_variables.WSLENV, 'USERPROFILE/up:WEZTERM_PANE/u:RAINBOW_SPINNER_WEZTERM_DIR/p')
  local config = { set_environment_variables = { WSLENV = 'RAINBOW_SPINNER_WEZTERM_DIR/p:FOO' } }
  eq(M.apply(config).set_environment_variables.WSLENV, 'RAINBOW_SPINNER_WEZTERM_DIR/p:FOO:WEZTERM_PANE')
end)

-- Ticks.

test('alive changes each tick once the folder is there', function()
  start {}
  eq(files[DIR .. '/alive'], nil)
  files[DIR] = true
  tick(500)
  local first = files[DIR .. '/alive']
  tick(500)
  assert(first and files[DIR .. '/alive'] ~= first)
end)

local function screen()
  return pane(1, { 'a', '\u{273B} ' .. MARK:rep(11) .. ' (3s)', 'b' })
end

both('a state that names its pane is drawn there only, from the tick that first reads it, and acked', function()
  local mine, decoy = screen(), pane(2, { MARK:rep(11) })
  start { panes = { mine, decoy } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick(500)
  eq(drawn(mine), 'sheet 2,3')
  eq(drawn(decoy), '')
  eq(files[DIR .. '/pane-1.ack'], files[DIR .. '/alive'])
  assert(mine.out[1]:find('a=t,t=f,f=100,i=5395201,q=2;' .. base64 '/x/pane-1-0.png', 1, true), 'the sheet read from its file')
end)

both('the sheet goes to WezTerm once per word, and each tick places the running frame, a band of it', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  for _ = 1, 3 do tick(40) end
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 2 }
  tick(40 * 43 + 80 - 120)
  eq(drawn(mine), 'sheet 2,3 2,3 2,3 2,3')
  local bands = {}
  for i, s in ipairs(mine.out) do
    bands[i] = s:match 'a=p,i=5395201,x=0,y=(%d+),w=275,h=48,c=11,r=1,C=1,q=2\x1b\\\x1b8$'
  end
  eq(table.concat(bands, ' '), '48 96 144 96')
end)

both('a frame is placed with no placement id, so text written over cells it was scrolled onto takes it away', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  tick()
  local placed = 0
  for _, s in ipairs(mine.out) do
    for keys in s:gmatch '\x1b_G([^;\x1b]*)' do
      if keys:find '^a=p,' then
        placed = placed + 1
        eq(('%s,'):format(keys):find(',p=%d+,'), nil)
      end
    end
  end
  eq(placed, 2)
end)

both('a sheet written again under the same name, for another word, is sent again', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', made = 1, beat = 1 }
  tick()
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', made = 3, beat = 2 }
  tick()
  eq(drawn(mine), 'sheet 2,3 delete sheet 2,3')
  assert(mine.out[2]:find('a=d,d=I,', 1, true), 'the sheet WezTerm holds is freed')
end)

test('a state that names no pane draws nothing and writes no ack', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  for beat = 1, 3 do
    files[DIR .. '/pane-1.state'] = state { cells = 11, frames = 'pane-1-0', beat = beat }
    tick()
  end
  eq(drawn(mine), '')
  eq(files[DIR .. '/pane-1.ack'], nil)
end)

both('a state unchanged for a minute goes with its ack, the sheets stay, and the state written again is drawn at once', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1-0.png'] = 'png'
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  eq(drawn(mine), 'sheet 2,3')
  tick(1500)
  tick(57000)
  eq(drawn(mine), 'sheet 2,3 delete')
  assert(files[DIR .. '/pane-1.state'] and files[DIR .. '/pane-1.ack'], 'kept for under a minute')
  tick(1500)
  eq(files[DIR .. '/pane-1.state'], nil)
  eq(files[DIR .. '/pane-1.ack'], nil)
  eq(files[DIR .. '/pane-1-0.png'], 'png')
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  eq(drawn(mine), 'sheet 2,3 delete sheet 2,3')
end)

both('a state caught halfway through a write is skipped', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = 'pane=1\ncells=11\nframeMs=40\ncount=43\nframes=pane-1-0\nbe'
  tick()
  files[DIR .. '/pane-1.state'] = ''
  tick()
  eq(drawn(mine), '')
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  eq(drawn(mine), 'sheet 2,3')
end)

both('the picture goes when the state names no frames, other cells, or stops changing', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  local beat = 0
  local function put(cells, frames)
    beat = beat + 1
    files[DIR .. '/pane-1.state'] = state { pane = 1, cells = cells, frames = frames, beat = beat }
    tick()
  end
  put(11, 'pane-1-0')
  put(11, nil)
  eq(drawn(mine), 'sheet 2,3 delete')
  put(11, 'pane-1-1')
  mine.rows[2] = MARK:rep(5)
  put(5, 'pane-1-1')
  eq(drawn(mine), 'sheet 2,3 delete sheet 2,3 delete sheet 2,1')
  tick(1500)
  eq(drawn(mine), 'sheet 2,3 delete sheet 2,3 delete sheet 2,1 delete')
end)

both('the row where the line was last found is read first', function()
  local mine = screen()
  local read = {}
  local get = mine.get_text_from_region
  function mine:get_text_from_region(x0, top, x1, bottom)
    for y = top, bottom do read[#read + 1] = y end
    return get(self, x0, top, x1, bottom)
  end
  start { panes = { mine } }
  files[DIR] = true
  for beat = 1, 2 do
    files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = beat }
    tick()
  end
  read = {}
  tick()
  table.sort(read)
  eq(read[1], 101)
  assert(read[#read] <= 102, "the line's row is read, and at most the one below it")
end)

both('marks that come up in the row below the line leave its frame where it was', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  mine.rows[3] = '  ' .. MARK:rep(11)
  tick()
  eq(drawn(mine), 'sheet 2,3 2,3')
end)

both('a line that moves a row down, under a row gone blank, is placed on its new row', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  table.insert(mine.rows, 2, '')
  tick()
  eq(drawn(mine), 'sheet 2,3 3,3')
end)

-- Only where the end row is taken in: where it is left out, the read of the
-- row below alone gives nothing, whatever the screen holds.
test('a row the program writes below between its two reads is passed over that tick', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick()
  -- The line moves a row down; the row it was on is read with it, and then,
  -- before the row below is read alone, the program writes over the line.
  mine.rows = { 'a', 'b', mine.rows[2] }
  local get = mine.get_text_from_region
  function mine:get_text_from_region(x0, top, x1, bottom)
    if top == 102 and bottom == 102 then self.rows[3] = '>' end
    return get(self, x0, top, x1, bottom)
  end
  tick()
  eq(drawn(mine), 'sheet 2,3')
end)

-- The panes, and the loop.

both('a state is read for each pane the mux lists, and not for a pane it does not list', function()
  local mine, other = screen(), pane(3, { MARK:rep(11) })
  start { panes = { mine, other }, listed = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  files[DIR .. '/pane-3.state'] = state { pane = 3, cells = 11, frames = 'pane-3-0', beat = 1 }
  tick(500)
  eq(drawn(mine), 'sheet 2,3')
  eq(drawn(other), '')
  eq(files[DIR .. '/pane-3.ack'], nil)
end)

both('the mux is asked for the panes once a slow tick, not on every fast tick', function()
  local mine = screen()
  start { panes = { mine } }
  files[DIR] = true
  files[DIR .. '/pane-1.state'] = state { pane = 1, cells = 11, frames = 'pane-1-0', beat = 1 }
  tick(500)
  local asked = W.listings
  for _ = 1, 10 do tick(40) end
  eq(W.slept, 20)
  eq(drawn(mine), 'sheet' .. (' 2,3'):rep(11))
  eq(W.listings, asked)
  tick(100)
  eq(W.listings, asked + 1)
end)

test('call_after is asked once, however many ticks there are', function()
  start {}
  files[DIR] = true
  for _ = 1, 5 do tick(500) end
  eq(W.slept, 500)
  eq(W.timers, 1)
end)

test('the loop ends once a newer state has taken the token', function()
  start {}
  files[DIR] = true
  tick(500)
  local seen = files[DIR .. '/alive']
  W.GLOBAL.rainbow_spinner_loop = 'a newer state'
  tick(500)
  eq(files[DIR .. '/alive'], seen)
  eq(coroutine.status(W.loop), 'dead')
end)

print(('%d passed'):format(passed))
