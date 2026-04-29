// claude-sdk-tui — bubbletea TUI front-end for the claude-sdk CLI.
//
// The TS host (`claude-sdk --tui`) spawns this binary and drives it over
// NDJSON on stdin/stdout. We never run the LLM ourselves; we only render and
// collect input. See ipc.go for the wire schema.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func main() {
	model := newModel()
	prog := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseAllMotion())
	go pumpHostEvents(prog)
	if _, err := prog.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui:", err)
		os.Exit(1)
	}
}

func pumpHostEvents(p *tea.Program) {
	for ev := range readEvents(os.Stdin) {
		p.Send(hostMsg{ev: ev})
	}
	p.Send(hostMsg{ev: HostEvent{Type: "__eof__"}})
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
	input      textinput.Model
	out        *writer
	ready      bool
}

func newModel() *model {
	in := textinput.New()
	in.Placeholder = "Type a prompt or /help. Ctrl+C exits."
	in.Focus()
	in.CharLimit = 4096
	in.Prompt = "> "
	return &model{
		input: in,
		out:   newWriter(),
	}
}

func (m *model) Init() tea.Cmd { return textinput.Blink }

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
			text := strings.TrimSpace(m.input.Value())
			if text == "" {
				return m, nil
			}
			m.input.SetValue("")
			if strings.HasPrefix(text, "/") {
				if text == "/exit" || text == "/quit" {
					m.out.send(UIEvent{Type: UIExit})
					return m, tea.Quit
				}
				m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("69")).Render(text))
				m.out.send(UIEvent{Type: UISlash, Cmd: text})
				return m, nil
			}
			m.appendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("141")).Render("> " + text))
			m.appendLine("")
			m.state = stateBusy
			m.refreshFooter()
			m.out.send(UIEvent{Type: UIPrompt, Text: text})
			return m, nil
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
		m.input.View(),
		m.footer,
	}, "\n")
}

func (m *model) layout() {
	headerH, footerH, inputH := 1, 1, 1
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
	m.input.Width = m.w - 2
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
	hint := "/help · /exit · Ctrl+C exit"
	if m.state == stateBusy {
		hint = "thinking… · /exit to quit"
	}
	if m.cwd != "" {
		hint = m.cwd + " · " + hint
	}
	m.footer = style.Render(hint)
}
