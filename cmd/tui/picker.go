// pickerState is a modal selector overlaid above the viewport. The TS host
// triggers it via EvtAsk; the user navigates with arrows / type-to-filter
// and the chosen value flows back as a UIAnswer event.
package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

type pickerState struct {
	id       string
	kind     string // select | confirm | text (text reserved)
	question string
	hint     string
	options  []AskOption
	idx      int
	filter   string // type-to-narrow within the option list
}

// visibleOptions returns the options matching the current filter prefix.
// When the filter is empty, all options are returned. Always non-nil.
func (p *pickerState) visibleOptions() []AskOption {
	if p == nil {
		return nil
	}
	if p.filter == "" {
		return p.options
	}
	needle := strings.ToLower(p.filter)
	out := make([]AskOption, 0, len(p.options))
	for _, opt := range p.options {
		hay := strings.ToLower(opt.Label)
		if hay == "" {
			hay = strings.ToLower(opt.Value)
		}
		if strings.Contains(hay, needle) {
			out = append(out, opt)
		}
	}
	return out
}

func (p *pickerState) selected() (AskOption, bool) {
	visible := p.visibleOptions()
	if p.idx < 0 || p.idx >= len(visible) {
		return AskOption{}, false
	}
	return visible[p.idx], true
}

// pickerView paints the modal overlay. We don't render a real overlay
// (bubbletea is line-based) — we draw a centred box of the right height
// and let the caller decide where in the View() composition to insert it.
func (p *pickerState) view(width int) string {
	if p == nil {
		return ""
	}
	// Reserve a sensible width: ~70% of terminal, but at least 50 cols.
	w := width * 7 / 10
	if w < 50 {
		w = 50
	}
	if w > width-4 {
		w = width - 4
	}

	titleStyle := lipgloss.NewStyle().
		Background(lipgloss.Color("202")).
		Foreground(lipgloss.Color("231")).
		Bold(true).
		Padding(0, 1)
	hintStyle := lipgloss.NewStyle().Foreground(colMuted)
	itemStyle := lipgloss.NewStyle().Foreground(colPrimary)
	selectedStyle := lipgloss.NewStyle().
		Background(lipgloss.Color("63")).
		Foreground(lipgloss.Color("231")).
		Bold(true)
	subStyle := lipgloss.NewStyle().Foreground(colSecondary)

	visible := p.visibleOptions()
	rows := make([]string, 0, len(visible)+4)
	rows = append(rows, titleStyle.Render(" "+p.kindLabel()+" "))
	rows = append(rows, lipgloss.NewStyle().Foreground(colPrimary).Bold(true).Render(p.question))
	if p.hint != "" {
		rows = append(rows, hintStyle.Render(p.hint))
	}
	if p.filter != "" {
		rows = append(rows, hintStyle.Render("filter: "+p.filter+"_"))
	}
	rows = append(rows, "")

	if len(visible) == 0 {
		rows = append(rows, subStyle.Render("(no matches — Esc to cancel)"))
	} else {
		for i, opt := range visible {
			label := opt.Label
			if label == "" {
				label = opt.Value
			}
			line := "  " + label
			if opt.Hint != "" {
				line += subStyle.Render("  " + opt.Hint)
			}
			if i == p.idx {
				line = selectedStyle.Width(w - 2).Render("▸ " + label)
				if opt.Hint != "" {
					line += subStyle.Render("  " + opt.Hint)
				}
			} else {
				line = itemStyle.Render(line)
			}
			rows = append(rows, line)
		}
	}
	rows = append(rows, "")
	rows = append(rows, hintStyle.Render("↑/↓ select · type to filter · Enter accept · Esc cancel"))

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("202")).
		Padding(0, 2).
		Width(w)
	return box.Render(strings.Join(rows, "\n"))
}

// pickerHeight estimates the rendered height so layout can reserve space.
// title + question + (hint?) + (filter?) + blank + N items (cap 8) + blank + footer
// + 2 border lines.
func pickerHeight(p *pickerState) int {
	if p == nil {
		return 0
	}
	rows := 4 // title + question + blank + footer
	if p.hint != "" {
		rows++
	}
	if p.filter != "" {
		rows++
	}
	visible := p.visibleOptions()
	count := len(visible)
	if count == 0 {
		rows++
	} else {
		if count > 8 {
			count = 8
		}
		rows += count
	}
	return rows + 2 // border
}

func (p *pickerState) kindLabel() string {
	switch p.kind {
	case "confirm":
		return "CONFIRM"
	case "text":
		return "INPUT"
	default:
		return "SELECT"
	}
}
