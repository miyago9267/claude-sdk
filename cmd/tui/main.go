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

	vp    viewport.Model
	input textarea.Model
	spin  spinner.Model
	out   *writer
	ready bool
}

const popupMaxRows = 6

type toolEntry struct {
	idx   int
	name  string
	input string
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
		mdRenderer:       r,
		mdStart:          -1,
		sessionStartedAt: time.Now(),
	}
}

func (m *model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.spin.Tick, tickEverySecond())
}

type secondTickMsg struct{}

func tickEverySecond() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return secondTickMsg{} })
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
		return m, tickEverySecond()

	case hostMsg:
		return m.applyHostEvent(msg.ev)

	case tea.KeyMsg:
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
			if strings.HasPrefix(text, "/") {
				if text == "/exit" || text == "/quit" {
					m.out.send(UIEvent{Type: UIExit})
					return m, tea.Quit
				}
				m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("69")).Render(text))
				m.out.send(UIEvent{Type: UISlash, Cmd: text})
				return m, nil
			}
			m.appendLine(renderUserPrompt(text))
			m.appendLine("")
			m.state = stateBusy
			m.refreshFooter()
			m.out.send(UIEvent{Type: UIPrompt, Text: text})
			return m, nil
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
		line := renderToolUse(ev.ToolName, ev.ToolInput, "pending")
		m.appendLine(line)
		if ev.ToolID != "" {
			m.toolByID[ev.ToolID] = toolEntry{
				idx:   len(m.transcript) - 1,
				name:  ev.ToolName,
				input: ev.ToolInput,
			}
		}
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
			m.transcript[entry.idx] = renderToolUse(entry.name, entry.input, status)
		}
		summary := singleLine(ev.Message, 100)
		marker := "  " + lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render("⎿ ")
		bodyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
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
			style := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
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
	if popup := m.suggestionsView(); popup != "" {
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

func (m *model) inputBox() string {
	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("63")).
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
	popupH := 0
	if n := len(m.suggestList); n > 0 {
		if n > popupMaxRows {
			n = popupMaxRows
		}
		// rows + separator + preview + 2 border lines
		popupH = n + 2 + 2
	}
	vpH := m.h - footerH - statusH - inputH - popupH - 1
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

// buildStatusLine1: model badge | short cwd + branch | session elapsed
func (m *model) buildStatusLine1() string {
	sep := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(" │ ")
	parts := []string{}

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
			text += " " + lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render("git:(") +
				lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true).Render(m.branch) +
				marker +
				lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render(")")
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
	sep := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(" │ ")
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
		count := lipgloss.NewStyle().Foreground(lipgloss.Color("245")).
			Render(fmt.Sprintf("(%s/%s)", humanTokens(m.context), humanTokens(m.contextMax)))
		if m.contextMax <= 0 {
			count = lipgloss.NewStyle().Foreground(lipgloss.Color("245")).
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
			lipgloss.NewStyle().Foreground(lipgloss.Color("251")).Render("Cost ")+
				lipgloss.NewStyle().Foreground(lipgloss.Color("215")).Bold(true).
					Render(fmt.Sprintf("$%.4f", m.cost)))
	}

	if m.compacts > 0 {
		parts = append(parts,
			lipgloss.NewStyle().Foreground(lipgloss.Color("141")).
				Render(fmt.Sprintf("⏷ ×%d", m.compacts)))
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, sep)
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

// modelColors returns a (bg, fg) tuple keyed by model family. opus → magenta,
// sonnet → blue, haiku → green, anything else → neutral grey.
func modelColors(model string) (lipgloss.Color, lipgloss.Color) {
	switch {
	case strings.Contains(model, "opus"):
		return lipgloss.Color("162"), lipgloss.Color("231") // pink/magenta
	case strings.Contains(model, "sonnet"):
		return lipgloss.Color("33"), lipgloss.Color("231") // blue
	case strings.Contains(model, "haiku"):
		return lipgloss.Color("36"), lipgloss.Color("231") // teal/green
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
			elapsed = " " + lipgloss.NewStyle().Foreground(lipgloss.Color("245")).
				Render(formatDuration(d))
		}
		hint = m.spin.View() + " " +
			lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true).Render("thinking…") +
			elapsed +
			dim.Render("  ·  Ctrl+C cancels")
	}
	m.footer = hint
}

func renderToolUse(name, input, status string) string {
	var dot string
	switch status {
	case "ok":
		dot = lipgloss.NewStyle().Foreground(lipgloss.Color("78")).Render("✓")
	case "err":
		dot = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("✗")
	default:
		dot = lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Render("⏺")
	}
	nameStyled := lipgloss.NewStyle().Bold(true).Render(name)
	if input == "" {
		return fmt.Sprintf("%s %s", dot, nameStyled)
	}
	args := lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Render("(" + input + ")")
	return fmt.Sprintf("%s %s%s", dot, nameStyled, args)
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
		BorderForeground(lipgloss.Color("141")).
		Foreground(lipgloss.Color("250")).
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
	logoStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("63"))
	tipStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Italic(true)
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
