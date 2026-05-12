// claude-sdk-tui — bubbletea TUI front-end for the claude-sdk CLI.
//
// The TS host (`claude-sdk --tui`) spawns this binary and drives it over
// NDJSON on stdin/stdout. We never run the LLM ourselves; we only render and
// collect input. See ipc.go for the wire schema.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

// IPC layout (set up by the TS host):
//   stdin (fd 0)  : NDJSON HostEvent stream  (TS -> us)
//   stdout (fd 1) : NDJSON UIEvent stream    (us -> TS)
//   stderr (fd 2) : human-readable diagnostics, inherited TTY
//
// bubbletea reads keys and paints to /dev/tty directly — never via stdin/
// stdout — so the IPC channels stay clean.
func main() {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "claude-sdk-tui: cannot open /dev/tty:", err)
		fmt.Fprintln(os.Stderr, "This binary must run attached to a terminal. Try `claude-sdk --tui`.")
		os.Exit(2)
	}
	if !fdLive(os.Stdin) || !fdLive(os.Stdout) {
		fmt.Fprintln(os.Stderr, "claude-sdk-tui: stdin/stdout aren't IPC pipes.")
		fmt.Fprintln(os.Stderr, "Run via `claude-sdk --tui`, not directly.")
		os.Exit(2)
	}

	model := newModel(os.Stdout)
	prog := tea.NewProgram(
		model,
		tea.WithAltScreen(),
		tea.WithInput(tty),
		tea.WithOutput(tty),
	)
	go pumpHostEvents(prog, os.Stdin)
	if _, err := prog.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui:", err)
		os.Exit(1)
	}
}

func pumpHostEvents(p *tea.Program, in *os.File) {
	for ev := range readEvents(in) {
		p.Send(hostMsg{ev: ev})
	}
	p.Send(hostMsg{ev: HostEvent{Type: "__eof__"}})
}

// fdLive returns true when the file descriptor backing f is actually open
// and usable. os.NewFile happily wraps any fd number even if it isn't open,
// so we have to probe — Stat fails with EBADF on a closed fd.
func fdLive(f *os.File) bool {
	if f == nil {
		return false
	}
	_, err := f.Stat()
	return err == nil
}

// ----------------------------------------------------------------------------

type uiState int

const (
	stateIdle uiState = iota
	stateBusy
)

type model struct {
	w, h     int
	header   string
	footer   string
	model    string
	cwd      string
	sid      string
	context  int
	cost     float64
	compacts int

	state uiState

	branch      string
	branchDirty bool

	statusLine1 string
	statusLine2 string
	sessionStartedAt time.Time

	// Estimated 5h Claude Max usage. Pushed by the TS host on every result;
	// remainingSec is what the host reports at that instant — we tick it
	// down locally each second between events.
	usagePct          float64
	usageRemainingSec int
	usageBudgetUSD    float64
	usageSpentUSD     float64
	usageStampedAt    time.Time

	transcript []string
	// toolByID lets a tool-result event find the transcript line carrying
	// the matching tool-use marker so we can rewrite it with the final
	// success/failure icon (and append `⎿ result` underneath).
	toolByID map[string]toolEntry

	// Per-turn timing: when busy starts so the footer can show elapsed.
	turnStartedAt time.Time

	// Markdown buffering. text-delta events accumulate into mdAccum and
	// stream verbatim into the transcript starting at mdStart. On any
	// non-text event (tool-use, tool-result, assistant-end) we flush:
	// re-render mdAccum through glamour and replace the verbatim slice.
	mdRenderer *glamour.TermRenderer
	mdAccum    string
	mdStart    int // -1 when no active accumulation

	// Optional, populated from result events. Gives the header an actual
	// percentage instead of just a token count.
	contextMax int

	// Slash-command autocomplete: full pool from EvtCapabilities, current
	// filtered subset based on the input value, and which one is highlighted.
	allCommands  []Candidate
	skills       []Candidate
	suggestList  []Candidate
	suggestIdx   int

	// Active tasks (sub-agent workflows) — same idea as toolByID.
	taskByID map[string]*taskEntry

	// Animation state
	welcomeFrame    int       // 0..2 during fade-in, then 3 = settled
	inputFlashUntil time.Time // input box border tinted green until this moment

	// Modal picker (active = non-nil). Takes over key handling and overlays
	// itself in View() above the input box.
	picker *pickerState

	vp    viewport.Model
	input textarea.Model
	spin  spinner.Model
	out   *writer
	ready bool
}

const popupMaxRows = 6

// Palette — adaptive so light terminals don't lose contrast. Use these
// instead of raw lipgloss.Color codes for any text that the user reads as
// foreground (sep glyphs, hints, labels). Backgrounds stay raw codes
// because the chips paint a fixed-dark surface.
var (
	colPrimary   lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "16", Dark: "252"}
	colSecondary lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "238", Dark: "245"}
	colMuted     lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "243", Dark: "240"}
	colAccent    lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "166", Dark: "208"} // Anthropic-ish orange
	colDanger    lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "160", Dark: "203"}
	colSuccess   lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "28", Dark: "78"}
	colWarning   lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "172", Dark: "214"}
	colHighlight lipgloss.TerminalColor = lipgloss.AdaptiveColor{Light: "55", Dark: "213"}
)

type toolEntry struct {
	idx       int
	name      string
	input     string
	startedAt time.Time
	done      bool
	kind      toolKind // builtin / mcp / skill — drives render style
}

type toolKind int

const (
	toolKindBuiltin toolKind = iota
	toolKindMcp
	toolKindSkill
)

type taskEntry struct {
	idx       int
	desc      string
	startedAt time.Time
	done      bool
}

func newModel(uiOut io.Writer) *model {
	ta := textarea.New()
	ta.Placeholder = "Ask Claude. Enter to send · Ctrl+J newline · /help"
	ta.Prompt = "│ "
	ta.CharLimit = 8192
	ta.SetHeight(3)
	ta.ShowLineNumbers = false
	ta.Focus()
	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()

	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))

	r, _ := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(0),
	)

	return &model{
		input:            ta,
		spin:             sp,
		out:              newWriter(uiOut),
		toolByID:         map[string]toolEntry{},
		taskByID:         map[string]*taskEntry{},
		mdRenderer:       r,
		mdStart:          -1,
		sessionStartedAt: time.Now(),
	}
}

func (m *model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.spin.Tick, tickEverySecond(), welcomeFrameTick())
}

type secondTickMsg struct{}

func tickEverySecond() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return secondTickMsg{} })
}

// welcomeFrameTick steps the splash logo through its three colour frames
// during cold-start. Stops once welcomeFrame >= 3.
type welcomeTickMsg struct{}

func welcomeFrameTick() tea.Cmd {
	return tea.Tick(220*time.Millisecond, func(t time.Time) tea.Msg { return welcomeTickMsg{} })
}

// hookFlashFadeMsg arrives ~400ms after a hook line was appended; we mutate
// the row from its bright background to its calm style.
type hookFlashFadeMsg struct {
	idx    int
	normal string
}

func scheduleHookFlashFade(idx int, normal string) tea.Cmd {
	return tea.Tick(400*time.Millisecond, func(t time.Time) tea.Msg {
		return hookFlashFadeMsg{idx: idx, normal: normal}
	})
}

// inputFlashFadeMsg triggers a re-render once the green send-confirmation
// border should expire.
type inputFlashFadeMsg struct{}

func scheduleInputFlashFade() tea.Cmd {
	return tea.Tick(220*time.Millisecond, func(t time.Time) tea.Msg {
		return inputFlashFadeMsg{}
	})
}

// ----------------------------------------------------------------------------

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.layout()
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		m.refreshFooter()
		return m, cmd

	case secondTickMsg:
		// Refresh elapsed time labels every second so the user sees the
		// session timer and cooking-elapsed counter advance.
		m.refreshStatusLines()
		m.refreshFooter()
		m.refreshActiveTools()
		return m, tickEverySecond()

	case welcomeTickMsg:
		if m.welcomeFrame < 3 {
			m.welcomeFrame++
			m.refreshViewport()
			if m.welcomeFrame < 3 {
				return m, welcomeFrameTick()
			}
		}
		return m, nil

	case hookFlashFadeMsg:
		if msg.idx >= 0 && msg.idx < len(m.transcript) {
			m.transcript[msg.idx] = msg.normal
			m.refreshViewport()
		}
		return m, nil

	case inputFlashFadeMsg:
		// noop: View rebuilds the input box and the colour falls back
		// because inputFlashUntil is now in the past.
		return m, nil

	case hostMsg:
		return m.applyHostEvent(msg.ev)

	case tea.KeyMsg:
		// When a modal picker is open it monopolises the keyboard. Ctrl+C
		// still exits the whole TUI, but everything else is routed to the
		// picker (arrows, Enter, Esc, type-to-filter).
		if m.picker != nil {
			return m.handlePickerKey(msg)
		}
		switch msg.Type {
		case tea.KeyCtrlC, tea.KeyCtrlD:
			m.out.send(UIEvent{Type: UIExit})
			return m, tea.Quit
		case tea.KeyEsc:
			if len(m.suggestList) > 0 {
				m.suggestList = nil
				m.suggestIdx = 0
				m.layout()
				return m, nil
			}
		case tea.KeyTab:
			if len(m.suggestList) > 0 {
				m.applySuggestion()
				return m, nil
			}
		case tea.KeyUp:
			if len(m.suggestList) > 0 {
				if m.suggestIdx > 0 {
					m.suggestIdx--
				}
				return m, nil
			}
		case tea.KeyDown:
			if len(m.suggestList) > 0 {
				if m.suggestIdx < len(m.suggestList)-1 {
					m.suggestIdx++
				}
				return m, nil
			}
		case tea.KeyEnter:
			// Plain Enter submits; Ctrl+J inserts a newline (handled below).
			text := strings.TrimSpace(m.input.Value())
			if text == "" {
				return m, nil
			}
			m.input.Reset()
			m.inputFlashUntil = time.Now().Add(220 * time.Millisecond)
			if strings.HasPrefix(text, "/") {
				if text == "/exit" || text == "/quit" {
					m.out.send(UIEvent{Type: UIExit})
					return m, tea.Quit
				}
				m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("69")).Render(text))
				m.out.send(UIEvent{Type: UISlash, Cmd: text})
				return m, scheduleInputFlashFade()
			}
			m.appendLine(renderUserPrompt(text))
			m.appendLine("")
			m.state = stateBusy
			m.refreshFooter()
			m.out.send(UIEvent{Type: UIPrompt, Text: text})
			return m, scheduleInputFlashFade()
		case tea.KeyCtrlJ:
			// Pass through to textarea so it inserts a newline.
			var cmd tea.Cmd
			m.input, cmd = m.input.Update(tea.KeyMsg{Type: tea.KeyEnter})
			return m, cmd
		case tea.KeyPgUp, tea.KeyPgDown, tea.KeyHome, tea.KeyEnd:
			var cmd tea.Cmd
			m.vp, cmd = m.vp.Update(msg)
			return m, cmd
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	m.recomputeSuggestions()
	return m, cmd
}

func (m *model) recomputeSuggestions() {
	value := m.input.Value()
	prev := len(m.suggestList)
	m.suggestList = filterCandidates(m.allCommands, value)
	if m.suggestIdx >= len(m.suggestList) {
		m.suggestIdx = 0
	}
	if (prev == 0) != (len(m.suggestList) == 0) {
		m.layout()
	}
}

// filterCandidates handles two modes:
//   - command mode  ("/m"   → /model, /memory, ...)
//   - argument mode ("/model so" → opus, sonnet, ...) once the user typed
//     a space after a command that publishes static args.
func filterCandidates(pool []Candidate, value string) []Candidate {
	if !strings.HasPrefix(value, "/") {
		return nil
	}
	if strings.ContainsAny(value, "\n\t") {
		return nil
	}

	spaceIdx := strings.Index(value, " ")
	if spaceIdx < 0 {
		out := make([]Candidate, 0, popupMaxRows)
		for _, c := range pool {
			if strings.HasPrefix(c.Name, value) {
				out = append(out, c)
				if len(out) >= popupMaxRows*4 {
					break
				}
			}
		}
		return out
	}

	cmdName := value[:spaceIdx]
	argPrefix := strings.TrimLeft(value[spaceIdx:], " ")

	var cmd *Candidate
	for i := range pool {
		if pool[i].Name == cmdName {
			cmd = &pool[i]
			break
		}
	}
	if cmd == nil || len(cmd.Args) == 0 {
		return nil
	}
	out := make([]Candidate, 0, popupMaxRows)
	for _, a := range cmd.Args {
		if strings.HasPrefix(a.Name, argPrefix) {
			out = append(out, Candidate{
				Name:        a.Name,
				Description: a.Description,
				Source:      "arg",
			})
			if len(out) >= popupMaxRows*4 {
				break
			}
		}
	}
	return out
}

func (m *model) applySuggestion() {
	if m.suggestIdx >= len(m.suggestList) {
		return
	}
	chosen := m.suggestList[m.suggestIdx].Name
	value := m.input.Value()

	spaceIdx := strings.Index(value, " ")
	var newVal string
	if spaceIdx < 0 {
		// command mode → "/cmd " so the next keystroke reveals arg suggestions
		newVal = chosen + " "
	} else {
		// arg mode → replace whatever the user partly typed after the command
		cmdPart := value[:spaceIdx]
		newVal = cmdPart + " " + chosen
	}
	m.input.SetValue(newVal)
	m.input.SetCursor(len(newVal))
	m.suggestIdx = 0
	// Don't clear suggestList here; recomputeSuggestions decides whether the
	// new value (now with trailing space) triggers the second-level popup.
	m.recomputeSuggestions()
	m.layout()
}

func (m *model) applyHostEvent(ev HostEvent) (tea.Model, tea.Cmd) {
	switch ev.Type {
	case EvtBanner:
		m.model = ev.Model
		m.cwd = ev.Cwd
		m.branch = ev.Branch
		m.branchDirty = ev.BranchDirty
		m.refreshHeader()
		m.refreshStatusLines()
		m.refreshFooter()
	case EvtTextDelta:
		m.streamMarkdown(ev.Text)
	case EvtToolUse:
		m.flushMarkdown()
		line := renderToolUse(ev.ToolName, ev.ToolInput, "pending", 0)
		m.appendLine(line)
		if ev.ToolID != "" {
			m.toolByID[ev.ToolID] = toolEntry{
				idx:       len(m.transcript) - 1,
				name:      ev.ToolName,
				input:     ev.ToolInput,
				startedAt: time.Now(),
				kind:      toolKindBuiltin,
			}
		}
	case EvtMcpCall:
		m.flushMarkdown()
		line := renderMcpCall(ev.McpServer, ev.McpTool, ev.ToolInput, "pending", 0)
		m.appendLine(line)
		if ev.ToolID != "" {
			m.toolByID[ev.ToolID] = toolEntry{
				idx:       len(m.transcript) - 1,
				name:      ev.McpServer + ":" + ev.McpTool,
				input:     ev.ToolInput,
				startedAt: time.Now(),
				kind:      toolKindMcp,
			}
		}
	case EvtSkillCall:
		m.flushMarkdown()
		line := renderSkillCall(ev.SkillName, "pending", 0)
		m.appendLine(line)
		if ev.ToolID != "" {
			m.toolByID[ev.ToolID] = toolEntry{
				idx:       len(m.transcript) - 1,
				name:      ev.SkillName,
				startedAt: time.Now(),
				kind:      toolKindSkill,
			}
		}
	case EvtHook:
		m.flushMarkdown()
		normal := renderHook(ev.HookEvent, ev.HookName, ev.HookStatus, ev.DurationMs)
		bright := renderHookFlashed(ev.HookEvent, ev.HookName, ev.HookStatus, ev.DurationMs)
		m.appendLine(bright)
		return m, scheduleHookFlashFade(len(m.transcript)-1, normal)
	case EvtTask:
		m.flushMarkdown()
		switch ev.TaskStatus {
		case "started":
			line := renderTask(ev.TaskDescription, "started", 0, 0)
			m.appendLine(line)
			if ev.TaskID != "" {
				m.taskByID[ev.TaskID] = &taskEntry{
					idx:       len(m.transcript) - 1,
					desc:      ev.TaskDescription,
					startedAt: time.Now(),
				}
			}
		case "progress":
			if entry, ok := m.taskByID[ev.TaskID]; ok && entry.idx < len(m.transcript) {
				elapsed := int(time.Since(entry.startedAt).Seconds())
				m.transcript[entry.idx] = renderTask(entry.desc, "progress", elapsed, ev.Tokens)
			}
		case "completed", "failed", "stopped":
			if entry, ok := m.taskByID[ev.TaskID]; ok && entry.idx < len(m.transcript) {
				elapsed := int(time.Since(entry.startedAt).Seconds())
				m.transcript[entry.idx] = renderTask(entry.desc, ev.TaskStatus, elapsed, ev.Tokens)
				entry.done = true
			}
		}
	case EvtToolProgress:
		// SDK push for elapsed sync; the 1s tick already redraws active
		// tools, so this event is a no-op except as a heartbeat. Treat it
		// as a hint to refresh in case the tick was missed.
		m.refreshActiveTools()
	case EvtToolResult:
		m.flushMarkdown()
		ok := ev.OK == nil || *ev.OK
		// Rewrite the original tool-use line so the leading bullet flips
		// from ⏺ (pending) to ✓/✗ (final).
		if entry, found := m.toolByID[ev.ToolID]; found && entry.idx < len(m.transcript) {
			status := "ok"
			if !ok {
				status = "err"
			}
			elapsed := int(time.Since(entry.startedAt).Seconds())
			switch entry.kind {
			case toolKindMcp:
				server, tool := splitMcpName(entry.name)
				m.transcript[entry.idx] = renderMcpCall(server, tool, entry.input, status, elapsed)
			case toolKindSkill:
				m.transcript[entry.idx] = renderSkillCall(entry.name, status, elapsed)
			default:
				m.transcript[entry.idx] = renderToolUse(entry.name, entry.input, status, elapsed)
			}
			entry.done = true
			m.toolByID[ev.ToolID] = entry
		}
		summary := singleLine(ev.Message, 100)
		marker := "  " + lipgloss.NewStyle().Foreground(colSecondary).Render("⎿ ")
		bodyStyle := lipgloss.NewStyle().Foreground(colSecondary)
		if !ok {
			bodyStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
		}
		m.appendLine(marker + bodyStyle.Render(summary))
	case EvtAssistantEnd:
		m.flushMarkdown()
		m.appendLine("")
		m.state = stateIdle
		m.refreshFooter()
	case EvtResult:
		if ev.SessionID != "" {
			m.sid = ev.SessionID
		}
		if ev.ContextTokens > 0 {
			m.context = ev.ContextTokens
		}
		if ev.ContextWindow > 0 {
			m.contextMax = ev.ContextWindow
		}
		if ev.CostUSD > 0 {
			m.cost = ev.CostUSD
		}
		if ev.Compactions > 0 {
			m.compacts = ev.Compactions
		}
		if ev.UsageBudgetUSD > 0 || ev.UsageSpentUSD > 0 || ev.UsageRemainingSec > 0 {
			m.usagePct = ev.UsagePct
			m.usageRemainingSec = ev.UsageRemainingSec
			m.usageBudgetUSD = ev.UsageBudgetUSD
			m.usageSpentUSD = ev.UsageSpentUSD
			m.usageStampedAt = time.Now()
		}
		m.refreshHeader()
		m.refreshStatusLines()
		m.state = stateIdle
		m.refreshFooter()
	case EvtError:
		m.flushMarkdown()
		m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Render("[error] " + ev.Message))
		m.state = stateIdle
		m.refreshFooter()
	case EvtStatus:
		// Optional metadata refresh (don't overwrite with empty values).
		if ev.Model != "" {
			m.model = ev.Model
		}
		if ev.Cwd != "" {
			m.cwd = ev.Cwd
		}
		if ev.Branch != "" {
			m.branch = ev.Branch
		}
		if ev.Type == EvtBanner || ev.Branch != "" {
			m.branchDirty = ev.BranchDirty
		}
		if ev.ContextTokens > 0 {
			m.context = ev.ContextTokens
		}
		if ev.ContextWindow > 0 {
			m.contextMax = ev.ContextWindow
		}
		if ev.CostUSD > 0 {
			m.cost = ev.CostUSD
		}
		if ev.Compactions > 0 {
			m.compacts = ev.Compactions
		}
		// Surface any human-readable message inline in the transcript so
		// /model, /commands, /skills, /status replies actually show up.
		if ev.Message != "" {
			m.flushMarkdown()
			style := lipgloss.NewStyle().Foreground(colSecondary)
			for _, line := range strings.Split(ev.Message, "\n") {
				m.appendLine(style.Render(line))
			}
		}
		m.refreshHeader()
		m.refreshStatusLines()
	case EvtBusy:
		if ev.Reason == "true" {
			m.state = stateBusy
			m.turnStartedAt = time.Now()
		} else {
			m.state = stateIdle
			m.turnStartedAt = time.Time{}
		}
		m.refreshFooter()
	case EvtCapabilities:
		var caps Capabilities
		if err := json.Unmarshal([]byte(ev.Payload), &caps); err == nil {
			m.allCommands = caps.Commands
			m.skills = caps.Skills
		}
	case EvtAsk:
		var req AskRequest
		if err := json.Unmarshal([]byte(ev.Payload), &req); err != nil {
			m.appendLine(lipgloss.NewStyle().Foreground(colDanger).
				Render("[ask] malformed payload: " + err.Error()))
			return m, nil
		}
		m.picker = &pickerState{
			id:       req.ID,
			kind:     req.Kind,
			question: req.Question,
			hint:     req.Hint,
			options:  req.Options,
		}
		m.layout()
	case "__eof__":
		return m, tea.Quit
	}
	return m, nil
}

// ----------------------------------------------------------------------------
// view

func (m *model) View() string {
	if !m.ready {
		return ""
	}
	parts := []string{m.vp.View()}
	if m.picker != nil {
		parts = append(parts, m.picker.view(m.w))
	} else if popup := m.suggestionsView(); popup != "" {
		parts = append(parts, popup)
	}
	parts = append(parts, m.inputBox())
	if m.statusLine1 != "" {
		parts = append(parts, m.statusLine1)
	}
	if m.statusLine2 != "" {
		parts = append(parts, m.statusLine2)
	}
	parts = append(parts, m.footer)
	return strings.Join(parts, "\n")
}

// handlePickerKey is called only when m.picker != nil.
func (m *model) handlePickerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyCtrlC:
		m.out.send(UIEvent{Type: UIExit})
		return m, tea.Quit
	case tea.KeyEsc:
		m.out.send(UIEvent{Type: UIAnswer, AskID: m.picker.id, Cancelled: true})
		m.picker = nil
		m.layout()
		return m, nil
	case tea.KeyUp:
		if m.picker.idx > 0 {
			m.picker.idx--
		}
		return m, nil
	case tea.KeyDown:
		visible := m.picker.visibleOptions()
		if m.picker.idx < len(visible)-1 {
			m.picker.idx++
		}
		return m, nil
	case tea.KeyEnter:
		if opt, ok := m.picker.selected(); ok {
			m.out.send(UIEvent{Type: UIAnswer, AskID: m.picker.id, Value: opt.Value})
			m.picker = nil
			m.layout()
		}
		return m, nil
	case tea.KeyBackspace:
		if len(m.picker.filter) > 0 {
			m.picker.filter = m.picker.filter[:len(m.picker.filter)-1]
			m.picker.idx = 0
		}
		return m, nil
	default:
		// Type-to-filter — append printable runes only.
		if len(msg.Runes) > 0 {
			r := msg.Runes[0]
			if r >= 32 && r != 127 {
				m.picker.filter += string(msg.Runes)
				m.picker.idx = 0
			}
		}
		return m, nil
	}
}

func (m *model) inputBox() string {
	borderColor := lipgloss.Color("63") // calm purple
	if !m.inputFlashUntil.IsZero() && time.Now().Before(m.inputFlashUntil) {
		borderColor = lipgloss.Color("78") // bright green flash on send
	}
	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(borderColor).
		Padding(0, 1).
		Width(m.w - 2)
	return border.Render(m.input.View())
}

func (m *model) suggestionsView() string {
	if len(m.suggestList) == 0 {
		return ""
	}
	rows := m.suggestList
	if len(rows) > popupMaxRows {
		rows = rows[:popupMaxRows]
	}
	itemStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
	srcStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("105"))
	sel := lipgloss.NewStyle().
		Background(lipgloss.Color("63")).
		Foreground(lipgloss.Color("231")).
		Bold(true)
	lines := make([]string, 0, len(rows)+2)
	for i, c := range rows {
		name := c.Name
		src := ""
		if c.Source != "" {
			src = srcStyle.Render(" [" + c.Source + "]")
		}
		line := itemStyle.Render(" "+name) + src
		if i == m.suggestIdx {
			line = sel.Width(m.w - 2).Render(" "+name) + src
		}
		lines = append(lines, line)
	}
	// Description preview for the highlighted entry. Single dim line below
	// the candidate list separated by a thin rule.
	if m.suggestIdx < len(rows) {
		sel := rows[m.suggestIdx]
		preview := sel.Description
		if preview == "" {
			preview = "(no description)"
		}
		lines = append(lines,
			lipgloss.NewStyle().Foreground(lipgloss.Color("238")).Render(strings.Repeat("─", m.w-4)),
		)
		lines = append(lines,
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("244")).
				Render(" ↳ "+truncate(preview, m.w-7)),
		)
	}
	box := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("241")).
		Width(m.w - 2)
	return box.Render(strings.Join(lines, "\n"))
}

func truncate(s string, n int) string {
	if n <= 1 || len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func (m *model) layout() {
	const footerH = 1
	statusH := 0
	if m.statusLine1 != "" {
		statusH++
	}
	if m.statusLine2 != "" {
		statusH++
	}
	if statusH == 0 {
		// Pre-banner phase: keep two slots reserved so footer doesn't jump
		// once the first status arrives.
		statusH = 2
	}
	inputH := m.input.Height() + 2
	overlayH := 0
	if m.picker != nil {
		// Picker takes priority over the slash popup. Reserve up to 12
		// rows; the picker view itself adapts to content.
		overlayH = pickerHeight(m.picker)
	} else if n := len(m.suggestList); n > 0 {
		if n > popupMaxRows {
			n = popupMaxRows
		}
		// rows + separator + preview + 2 border lines
		overlayH = n + 2 + 2
	}
	vpH := m.h - footerH - statusH - inputH - overlayH - 1
	if vpH < 3 {
		vpH = 3
	}
	if !m.ready {
		m.vp = viewport.New(m.w, vpH)
		m.ready = true
	} else {
		m.vp.Width = m.w
		m.vp.Height = vpH
	}
	m.input.SetWidth(m.w - 6)
	m.refreshStatusLines()
	if m.mdRenderer != nil {
		// Re-init renderer with the current width so word wrap matches.
		if r, err := glamour.NewTermRenderer(
			glamour.WithAutoStyle(),
			glamour.WithWordWrap(m.w-2),
		); err == nil {
			m.mdRenderer = r
		}
	}
	m.refreshHeader()
	m.refreshFooter()
	m.refreshViewport()
	m.vp.GotoBottom()
}

func (m *model) appendLine(line string) {
	m.transcript = append(m.transcript, line)
	m.refreshViewport()
}

func (m *model) appendInline(text string) {
	if len(m.transcript) == 0 {
		m.transcript = []string{text}
	} else {
		last := len(m.transcript) - 1
		m.transcript[last] += text
	}
	m.refreshViewport()
}

// streamMarkdown accumulates the assistant text-delta stream so we can
// re-render it as Markdown on flush. While streaming we replace the
// trailing slice transcript[mdStart:] with the verbatim accumulator split
// by newline; the transcript stays consistent for layout but rendering
// quality is upgraded once the turn ends.
func (m *model) streamMarkdown(text string) {
	if m.mdStart < 0 {
		m.mdStart = len(m.transcript)
	}
	m.mdAccum += text
	m.transcript = m.transcript[:m.mdStart]
	for _, line := range strings.Split(m.mdAccum, "\n") {
		m.transcript = append(m.transcript, line)
	}
	m.refreshViewport()
}

func (m *model) flushMarkdown() {
	if m.mdStart < 0 || m.mdAccum == "" {
		m.mdStart = -1
		m.mdAccum = ""
		return
	}
	rendered := m.mdAccum
	if m.mdRenderer != nil {
		if out, err := m.mdRenderer.Render(m.mdAccum); err == nil {
			rendered = strings.TrimRight(out, "\n")
		}
	}
	m.transcript = m.transcript[:m.mdStart]
	for _, line := range strings.Split(rendered, "\n") {
		m.transcript = append(m.transcript, line)
	}
	m.mdStart = -1
	m.mdAccum = ""
	m.refreshViewport()
}

func (m *model) refreshViewport() {
	if !m.ready {
		return
	}
	if len(m.transcript) == 0 {
		m.vp.SetContent(m.renderWelcome())
		return
	}
	m.vp.SetContent(strings.Join(m.transcript, "\n"))
	m.vp.GotoBottom()
}

// refreshHeader is a no-op now — all status info moved to the bottom
// statusLines. Kept so existing call sites compile; we may revive it later
// for a brand bar.
func (m *model) refreshHeader() {
	m.header = ""
}

func (m *model) refreshStatusLines() {
	m.statusLine1 = m.buildStatusLine1()
	m.statusLine2 = m.buildStatusLine2()
}

// buildStatusLine1: brand badge | model badge | short cwd + branch | session elapsed
func (m *model) buildStatusLine1() string {
	sep := lipgloss.NewStyle().Foreground(colMuted).Render(" │ ")

	brand := lipgloss.NewStyle().
		Background(lipgloss.Color("202")). // Anthropic-ish orange
		Foreground(lipgloss.Color("231")).
		Padding(0, 1).
		Bold(true).
		Render("claude-sdk")
	parts := []string{brand}

	if m.model != "" {
		bg, fg := modelColors(m.model)
		label := m.model
		if m.contextMax > 0 {
			label = fmt.Sprintf("%s (%s)", m.model, humanTokens(m.contextMax))
		}
		parts = append(parts, lipgloss.NewStyle().
			Background(bg).Foreground(fg).Padding(0, 1).Bold(true).Render(label))
	}

	if m.cwd != "" {
		text := shortCwd(m.cwd)
		if m.branch != "" {
			marker := ""
			if m.branchDirty {
				marker = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("*")
			}
			text += " " + lipgloss.NewStyle().Foreground(colSecondary).Render("git:(") +
				lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true).Render(m.branch) +
				marker +
				lipgloss.NewStyle().Foreground(colSecondary).Render(")")
		}
		parts = append(parts, lipgloss.NewStyle().Foreground(lipgloss.Color("75")).Render(text))
	}

	if !m.sessionStartedAt.IsZero() {
		elapsed := time.Since(m.sessionStartedAt)
		parts = append(parts, lipgloss.NewStyle().
			Foreground(lipgloss.Color("245")).
			Render("⏱  "+formatDuration(elapsed)))
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, sep)
}

// buildStatusLine2: Context bar % | Cost | Compacts
func (m *model) buildStatusLine2() string {
	sep := lipgloss.NewStyle().Foreground(colMuted).Render(" │ ")
	parts := []string{}

	if m.context > 0 || m.contextMax > 0 {
		var pct float64
		if m.contextMax > 0 {
			pct = float64(m.context) / float64(m.contextMax)
			if pct > 1 {
				pct = 1
			}
		}
		color := contextSeverityColor(pct)
		bar := renderProgressBar(pct, 10, color)
		label := lipgloss.NewStyle().
			Foreground(lipgloss.Color("251")).
			Render("Context")
		valStyle := lipgloss.NewStyle().Foreground(color).Bold(true)
		percent := valStyle.Render(fmt.Sprintf("%.0f%%", pct*100))
		count := lipgloss.NewStyle().Foreground(colSecondary).
			Render(fmt.Sprintf("(%s/%s)", humanTokens(m.context), humanTokens(m.contextMax)))
		if m.contextMax <= 0 {
			count = lipgloss.NewStyle().Foreground(colSecondary).
				Render(fmt.Sprintf("(~%s)", humanTokens(m.context)))
			percent = ""
		}
		segs := []string{label, bar}
		if percent != "" {
			segs = append(segs, percent)
		}
		segs = append(segs, count)
		parts = append(parts, strings.Join(segs, " "))
	}

	if m.cost > 0 {
		parts = append(parts,
			lipgloss.NewStyle().Foreground(colPrimary).Render("Cost ")+
				lipgloss.NewStyle().Foreground(lipgloss.Color("215")).Bold(true).
					Render(fmt.Sprintf("$%.4f", m.cost)))
	}

	if m.compacts > 0 {
		parts = append(parts,
			lipgloss.NewStyle().Foreground(lipgloss.Color("141")).
				Render(fmt.Sprintf("⏷ ×%d", m.compacts)))
	}

	if usage := m.buildUsageSegment(); usage != "" {
		parts = append(parts, usage)
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, sep)
}

// buildUsageSegment renders the Usage progress bar with reset countdown.
// Returns "" if the host hasn't pushed any usage estimate yet.
func (m *model) buildUsageSegment() string {
	if m.usageBudgetUSD <= 0 && m.usageSpentUSD <= 0 && m.usageRemainingSec <= 0 {
		return ""
	}
	color := contextSeverityColor(m.usagePct)
	bar := renderProgressBar(m.usagePct, 10, color)
	label := lipgloss.NewStyle().Foreground(colPrimary).Render("Usage")
	pct := lipgloss.NewStyle().Foreground(color).Bold(true).
		Render(fmt.Sprintf("%.0f%%", m.usagePct*100))

	// Tick the remaining seconds down locally between server pushes so the
	// countdown doesn't sit static.
	remaining := m.usageRemainingSec
	if !m.usageStampedAt.IsZero() {
		drift := int(time.Since(m.usageStampedAt).Seconds())
		remaining -= drift
		if remaining < 0 {
			remaining = 0
		}
	}
	resets := lipgloss.NewStyle().Foreground(colSecondary).
		Render(fmt.Sprintf("(resets in %s)", formatDuration(time.Duration(remaining)*time.Second)))

	return strings.Join([]string{label, bar, pct, resets}, " ")
}

func contextSeverityColor(pct float64) lipgloss.Color {
	if pct >= 0.9 {
		return lipgloss.Color("203")
	}
	if pct >= 0.7 {
		return lipgloss.Color("214")
	}
	return lipgloss.Color("78")
}

// shortCwd reduces /Users/foo/Project/AI/claude-sdk to "AI/claude-sdk".
func shortCwd(p string) string {
	if p == "" {
		return ""
	}
	parts := strings.Split(p, string(os.PathSeparator))
	// drop empties from leading separator
	clean := make([]string, 0, len(parts))
	for _, s := range parts {
		if s != "" {
			clean = append(clean, s)
		}
	}
	if len(clean) <= 2 {
		return strings.Join(clean, "/")
	}
	return strings.Join(clean[len(clean)-2:], "/")
}

func formatDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	h := int(d.Hours())
	mm := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, mm)
	case mm > 0:
		return fmt.Sprintf("%dm %ds", mm, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}

// modelColors returns a (bg, fg) tuple keyed by model family. Picked from
// the 256-colour cube to read clearly against both light and dark
// terminals while still distinguishing each family at a glance.
func modelColors(model string) (lipgloss.Color, lipgloss.Color) {
	switch {
	case strings.Contains(model, "opus"):
		return lipgloss.Color("198"), lipgloss.Color("231") // hot pink
	case strings.Contains(model, "sonnet"):
		return lipgloss.Color("32"), lipgloss.Color("231") // saturated blue
	case strings.Contains(model, "haiku"):
		return lipgloss.Color("35"), lipgloss.Color("231") // saturated teal
	default:
		return lipgloss.Color("240"), lipgloss.Color("231")
	}
}

// contextChip renders either a numeric chip (when contextMax is unknown) or
// a coloured progress bar with absolute count + percent.
func (m *model) contextChip() string {
	if m.contextMax <= 0 {
		return lipgloss.NewStyle().
			Background(lipgloss.Color("237")).
			Foreground(lipgloss.Color("245")).
			Padding(0, 1).
			Render(fmt.Sprintf("ctx ~%s", humanTokens(m.context)))
	}
	pct := float64(m.context) / float64(m.contextMax)
	if pct > 1 {
		pct = 1
	}
	color := lipgloss.Color("78") // green
	if pct >= 0.7 {
		color = lipgloss.Color("214") // amber
	}
	if pct >= 0.9 {
		color = lipgloss.Color("203") // red
	}
	bar := renderProgressBar(pct, 10, color)
	label := fmt.Sprintf("%s/%s %.0f%%", humanTokens(m.context), humanTokens(m.contextMax), pct*100)
	return lipgloss.NewStyle().
		Background(lipgloss.Color("237")).
		Padding(0, 1).
		Render(bar + " " + lipgloss.NewStyle().
			Background(lipgloss.Color("237")).
			Foreground(color).
			Bold(true).
			Render(label))
}

func renderProgressBar(pct float64, width int, color lipgloss.Color) string {
	if pct < 0 {
		pct = 0
	}
	if pct > 1 {
		pct = 1
	}
	filled := int(math.Round(float64(width) * pct))
	if filled > width {
		filled = width
	}
	full := lipgloss.NewStyle().Foreground(color).Render(strings.Repeat("█", filled))
	empty := lipgloss.NewStyle().Foreground(lipgloss.Color("238")).Render(strings.Repeat("░", width-filled))
	return full + empty
}

func (m *model) refreshFooter() {
	dim := lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	hint := dim.Render("Enter send · Ctrl+J newline · /help · Ctrl+C exit")
	if m.state == stateBusy {
		elapsed := ""
		if !m.turnStartedAt.IsZero() {
			d := time.Since(m.turnStartedAt)
			elapsed = " " + lipgloss.NewStyle().Foreground(colSecondary).
				Render(formatDuration(d))
		}
		hint = m.spin.View() + " " +
			lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true).Render("thinking…") +
			elapsed +
			dim.Render("  ·  Ctrl+C cancels")
	}
	m.footer = hint
}

func renderToolUse(name, input, status string, elapsed int) string {
	dot := statusGlyph(status, lipgloss.Color("220"))
	nameStyled := lipgloss.NewStyle().Bold(true).Render(name)
	suffix := ""
	if input != "" {
		suffix = lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Render("(" + input + ")")
	}
	return joinWithElapsed(fmt.Sprintf("%s %s%s", dot, nameStyled, suffix), status, elapsed)
}

// renderMcpCall formats a tool_use whose name was mcp__<server>__<tool>.
// The server name is hashed to a stable colour so different servers stand
// out at a glance.
func renderMcpCall(server, tool, input, status string, elapsed int) string {
	dot := statusGlyph(status, lipgloss.Color("39"))
	serverStyle := lipgloss.NewStyle().Background(mcpServerColor(server)).
		Foreground(lipgloss.Color("231")).Padding(0, 1).Bold(true)
	header := fmt.Sprintf("%s %s %s",
		dot,
		serverStyle.Render("mcp:"+server),
		lipgloss.NewStyle().Bold(true).Render(tool),
	)
	if input != "" {
		header += lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Render("(" + input + ")")
	}
	return joinWithElapsed(header, status, elapsed)
}

func renderSkillCall(name, status string, elapsed int) string {
	dot := statusGlyph(status, lipgloss.Color("214"))
	badge := lipgloss.NewStyle().Background(lipgloss.Color("142")).
		Foreground(lipgloss.Color("231")).Padding(0, 1).Bold(true).Render("skill")
	nameStyled := lipgloss.NewStyle().Foreground(lipgloss.Color("228")).Bold(true).Render(name)
	return joinWithElapsed(fmt.Sprintf("%s %s %s", dot, badge, nameStyled), status, elapsed)
}

// renderHookFlashed adds a leading 'NEW' badge that fades after a few
// hundred ms, drawing the eye to the latest hook fired.
func renderHookFlashed(event, name, status string, durationMs int) string {
	badge := lipgloss.NewStyle().
		Background(lipgloss.Color("228")).
		Foreground(lipgloss.Color("16")).
		Bold(true).
		Padding(0, 1).
		Render("NEW")
	return badge + " " + renderHook(event, name, status, durationMs)
}

func renderHook(event, name, status string, durationMs int) string {
	gear := lipgloss.NewStyle().Foreground(lipgloss.Color("141")).Render("⚙")
	eventStyled := lipgloss.NewStyle().
		Background(lipgloss.Color("60")).
		Foreground(lipgloss.Color("231")).
		Padding(0, 1).
		Render(event)
	nameStyled := lipgloss.NewStyle().Foreground(lipgloss.Color("250")).Render(name)
	suffix := ""
	switch status {
	case "ok":
		suffix = lipgloss.NewStyle().Foreground(lipgloss.Color("78")).Render(
			fmt.Sprintf(" ✓ %dms", durationMs))
	case "err":
		suffix = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render(
			fmt.Sprintf(" ✗ %dms", durationMs))
	default:
		suffix = lipgloss.NewStyle().Foreground(colSecondary).Render(" started…")
	}
	return fmt.Sprintf("%s %s %s%s", gear, eventStyled, nameStyled, suffix)
}

func renderTask(desc, status string, elapsedSec, tokens int) string {
	arrow := lipgloss.NewStyle().Foreground(lipgloss.Color("36")).Render("▸")
	badge := lipgloss.NewStyle().Background(lipgloss.Color("36")).
		Foreground(lipgloss.Color("231")).Padding(0, 1).Bold(true).Render("task")
	descStyled := lipgloss.NewStyle().Foreground(colPrimary).Render(desc)
	parts := []string{fmt.Sprintf("%s %s %s", arrow, badge, descStyled)}
	if elapsedSec > 0 {
		parts = append(parts, lipgloss.NewStyle().Foreground(colSecondary).
			Render(fmt.Sprintf("· %ds", elapsedSec)))
	}
	if tokens > 0 {
		parts = append(parts, lipgloss.NewStyle().Foreground(colSecondary).
			Render(fmt.Sprintf("· %s tok", humanTokens(tokens))))
	}
	switch status {
	case "completed":
		parts = append(parts, lipgloss.NewStyle().Foreground(lipgloss.Color("78")).Render("✓"))
	case "failed":
		parts = append(parts, lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("✗"))
	case "stopped":
		parts = append(parts, lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Render("⏸"))
	}
	return strings.Join(parts, " ")
}

func statusGlyph(status string, pendingColor lipgloss.Color) string {
	switch status {
	case "ok":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("78")).Render("✓")
	case "err":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("✗")
	default:
		return lipgloss.NewStyle().Foreground(pendingColor).Render("⏺")
	}
}

func joinWithElapsed(line, status string, elapsed int) string {
	if elapsed <= 0 || status != "pending" {
		return line
	}
	return line + " " + lipgloss.NewStyle().Foreground(colSecondary).
		Render(fmt.Sprintf("(%ds)", elapsed))
}

// mcpServerColor maps a server name to a stable lipgloss colour from a small
// palette so different servers visually separate.
func mcpServerColor(name string) lipgloss.Color {
	palette := []lipgloss.Color{
		lipgloss.Color("39"),  // cyan
		lipgloss.Color("141"), // violet
		lipgloss.Color("204"), // pink
		lipgloss.Color("172"), // amber
		lipgloss.Color("36"),  // teal
	}
	if name == "" {
		return palette[0]
	}
	var sum int
	for _, c := range name {
		sum += int(c)
	}
	return palette[sum%len(palette)]
}

func splitMcpName(label string) (server, tool string) {
	if i := strings.IndexByte(label, ':'); i >= 0 {
		return label[:i], label[i+1:]
	}
	return label, ""
}

// refreshActiveTools rewrites every still-pending tool line with the current
// elapsed time. Driven by the 1s tick.
func (m *model) refreshActiveTools() {
	for id, entry := range m.toolByID {
		if entry.done {
			continue
		}
		if entry.idx >= len(m.transcript) {
			continue
		}
		elapsed := int(time.Since(entry.startedAt).Seconds())
		switch entry.kind {
		case toolKindMcp:
			server, tool := splitMcpName(entry.name)
			m.transcript[entry.idx] = renderMcpCall(server, tool, entry.input, "pending", elapsed)
		case toolKindSkill:
			m.transcript[entry.idx] = renderSkillCall(entry.name, "pending", elapsed)
		default:
			m.transcript[entry.idx] = renderToolUse(entry.name, entry.input, "pending", elapsed)
		}
		_ = id
	}
	for _, entry := range m.taskByID {
		if entry.done {
			continue
		}
		if entry.idx >= len(m.transcript) {
			continue
		}
		elapsed := int(time.Since(entry.startedAt).Seconds())
		m.transcript[entry.idx] = renderTask(entry.desc, "progress", elapsed, 0)
	}
	m.refreshViewport()
}

func humanTokens(n int) string {
	if n >= 1000 {
		return fmt.Sprintf("%.1fK", float64(n)/1000)
	}
	return fmt.Sprintf("%d", n)
}

func renderUserPrompt(text string) string {
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(colHighlight).
		Foreground(colPrimary).
		PaddingLeft(1).
		Render(text)
}

var welcomeTips = []string{
	"Type a prompt and hit Enter to send.",
	"Press / to bring up the slash command palette.",
	"Tab applies the highlighted suggestion · Esc dismisses it.",
	"Ctrl+J inserts a newline · Enter submits.",
	"PgUp / PgDn scrolls back through the transcript.",
	"/clear drops the session · /compact frees context tokens.",
	"/model claude-haiku-4-5 to swap models mid-conversation.",
	"/self toggles self-edit mode (claude-sdk root in additionalDirectories).",
	"/skills lists installed skills · /commands lists slash commands.",
	"Long replies render as Markdown when the turn finishes.",
}

var welcomeLogo = `
   _____ _                 _      _____ _____  _  __
  / ____| |               | |    / ____|  __ \| |/ /
 | |    | | __ _ _   _  __| | __| (___ | |  | | ' /
 | |    | |/ _` + "`" + ` | | | |/ _` + "`" + ` |/ _ \\___ \| |  | |  <
 | |____| | (_| | |_| | (_| |  __/____) | |__| | . \
  \_____|_|\__,_|\__,_|\__,_|\___|_____/|_____/|_|\_\
`

func (m *model) renderWelcome() string {
	// Fade-in palette: dim → mid → bright → settled. welcomeFrame steps via
	// the welcomeTick command issued from Init().
	logoColors := []lipgloss.Color{
		lipgloss.Color("240"), // dim grey
		lipgloss.Color("60"),  // mid purple
		lipgloss.Color("99"),  // bright magenta
		lipgloss.Color("63"),  // settled
	}
	frame := m.welcomeFrame
	if frame > len(logoColors)-1 {
		frame = len(logoColors) - 1
	}
	logoStyle := lipgloss.NewStyle().Foreground(logoColors[frame])
	tipStyle := lipgloss.NewStyle().Foreground(colSecondary).Italic(true)
	hintStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("105")).Bold(true)

	tip := welcomeTips[rand.Intn(len(welcomeTips))]

	body := strings.Join([]string{
		logoStyle.Render(strings.TrimLeft(welcomeLogo, "\n")),
		"",
		hintStyle.Render("  Welcome to claude-sdk."),
		"",
		tipStyle.Render("  tip: " + tip),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("241")).Render(
			"  cwd: " + m.cwd + "  ·  model: " + m.model,
		),
	}, "\n")
	return body
}

func singleLine(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
