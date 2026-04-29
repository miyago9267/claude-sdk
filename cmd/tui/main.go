// claude-sdk-tui — bubbletea TUI front-end for the claude-sdk CLI.
//
// The TS host (`claude-sdk --tui`) spawns this binary and drives it over
// NDJSON on stdin/stdout. We never run the LLM ourselves; we only render and
// collect input. See ipc.go for the wire schema.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
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

	transcript []string
	vp         viewport.Model
	input      textarea.Model
	out        *writer
	ready      bool
}

func newModel(uiOut io.Writer) *model {
	ta := textarea.New()
	ta.Placeholder = "Ask Claude anything. Enter to send, Ctrl+J newline."
	ta.Prompt = "│ "
	ta.CharLimit = 8192
	ta.SetHeight(3)
	ta.ShowLineNumbers = false
	ta.Focus()
	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()
	return &model{
		input: ta,
		out:   newWriter(uiOut),
	}
}

func (m *model) Init() tea.Cmd { return textarea.Blink }

// ----------------------------------------------------------------------------

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.layout()
		return m, nil

	case hostMsg:
		return m.applyHostEvent(msg.ev)

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC, tea.KeyCtrlD:
			m.out.send(UIEvent{Type: UIExit})
			return m, tea.Quit
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
			for _, line := range strings.Split(text, "\n") {
				m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("141")).Render("> " + line))
			}
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
		case tea.KeyPgUp, tea.KeyPgDown, tea.KeyUp, tea.KeyDown, tea.KeyHome, tea.KeyEnd:
			var cmd tea.Cmd
			m.vp, cmd = m.vp.Update(msg)
			return m, cmd
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m *model) applyHostEvent(ev HostEvent) (tea.Model, tea.Cmd) {
	switch ev.Type {
	case EvtBanner:
		m.model = ev.Model
		m.cwd = ev.Cwd
		m.refreshHeader()
		m.refreshFooter()
	case EvtTextDelta:
		m.appendInline(ev.Text)
	case EvtToolUse:
		m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render(
			fmt.Sprintf("  [tool] %s", ev.ToolName)))
	case EvtAssistantEnd:
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
		if ev.CostUSD > 0 {
			m.cost = ev.CostUSD
		}
		if ev.Compactions > 0 {
			m.compacts = ev.Compactions
		}
		m.refreshHeader()
		m.state = stateIdle
		m.refreshFooter()
	case EvtError:
		m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Render("[error] " + ev.Message))
		m.state = stateIdle
		m.refreshFooter()
	case EvtStatus:
		m.model = ev.Model
		m.cwd = ev.Cwd
		m.context = ev.ContextTokens
		m.cost = ev.CostUSD
		m.compacts = ev.Compactions
		m.refreshHeader()
	case EvtBusy:
		if ev.Reason == "true" {
			m.state = stateBusy
		} else {
			m.state = stateIdle
		}
		m.refreshFooter()
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
	return strings.Join([]string{
		m.header,
		m.vp.View(),
		m.inputBox(),
		m.footer,
	}, "\n")
}

func (m *model) inputBox() string {
	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("63")).
		Padding(0, 1).
		Width(m.w - 2)
	return border.Render(m.input.View())
}

func (m *model) layout() {
	const headerH, footerH = 1, 1
	inputH := m.input.Height() + 2
	vpH := m.h - headerH - footerH - inputH - 1
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
	m.refreshHeader()
	m.refreshFooter()
	m.vp.SetContent(strings.Join(m.transcript, "\n"))
	m.vp.GotoBottom()
}

func (m *model) appendLine(line string) {
	m.transcript = append(m.transcript, line)
	if m.ready {
		m.vp.SetContent(strings.Join(m.transcript, "\n"))
		m.vp.GotoBottom()
	}
}

func (m *model) appendInline(text string) {
	if len(m.transcript) == 0 {
		m.transcript = []string{text}
	} else {
		last := len(m.transcript) - 1
		m.transcript[last] += text
	}
	if m.ready {
		m.vp.SetContent(strings.Join(m.transcript, "\n"))
		m.vp.GotoBottom()
	}
}

func (m *model) refreshHeader() {
	style := lipgloss.NewStyle().Background(lipgloss.Color("236")).Foreground(lipgloss.Color("252")).Padding(0, 1)
	parts := []string{"claude-sdk"}
	if m.model != "" {
		parts = append(parts, "model:"+m.model)
	}
	if m.context > 0 {
		parts = append(parts, fmt.Sprintf("ctx:~%d", m.context))
	}
	if m.cost > 0 {
		parts = append(parts, fmt.Sprintf("$%.4f", m.cost))
	}
	if m.compacts > 0 {
		parts = append(parts, fmt.Sprintf("compacts:%d", m.compacts))
	}
	m.header = style.Width(m.w).Render(strings.Join(parts, " · "))
}

func (m *model) refreshFooter() {
	style := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	if m.state == stateBusy {
		style = style.Foreground(lipgloss.Color("214"))
	}
	hint := "Enter send · Ctrl+J newline · /help · Ctrl+C exit"
	if m.state == stateBusy {
		hint = "thinking… · Ctrl+C cancels"
	}
	if m.cwd != "" {
		hint = m.cwd + "  ·  " + hint
	}
	m.footer = style.Render(hint)
}
