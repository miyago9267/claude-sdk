// Package main — IPC types and codecs for the TS host process.
//
// Wire format is NDJSON: one JSON object per line, line-terminated. Inbound
// messages travel from the TS host (claude-sdk bin) into our stdin; outbound
// messages travel from us back to the host via stdout.
//
// Keep this in sync with src/cli/tui.ts on the TS side.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// HostEvent is anything the TS host pushes us about the current LLM session.
type HostEvent struct {
	Type          string  `json:"type"`
	Text          string  `json:"text,omitempty"`
	Model         string  `json:"model,omitempty"`
	Cwd           string  `json:"cwd,omitempty"`
	Branch        string  `json:"branch,omitempty"`
	BranchDirty   bool    `json:"branchDirty,omitempty"`
	ToolName      string  `json:"name,omitempty"`
	ToolID        string  `json:"id,omitempty"`
	ToolInput     string  `json:"input,omitempty"`
	OK            *bool   `json:"ok,omitempty"`
	SessionID     string  `json:"sessionId,omitempty"`
	ContextTokens int     `json:"contextTokens,omitempty"`
	ContextWindow int     `json:"contextWindow,omitempty"`
	CostUSD       float64 `json:"costUSD,omitempty"`
	Compactions   int     `json:"compactions,omitempty"`
	Message       string  `json:"message,omitempty"`
	Reason        string  `json:"reason,omitempty"`
	Payload       string  `json:"payload,omitempty"`
}

// HostEventTypes documents every value of HostEvent.Type. Comments here are
// the canonical schema for the TS side.
const (
	EvtBanner       = "banner"        // initial header info (model, cwd)
	EvtTextDelta    = "text-delta"    // assistant text fragment
	EvtToolUse      = "tool-use"      // tool started server-side
	EvtToolResult   = "tool-result"   // server-side tool finished
	EvtAssistantEnd = "assistant-end" // current assistant turn finished
	EvtResult       = "result"        // turn final, includes usage
	EvtError        = "error"         // surface error
	EvtStatus       = "status"        // pushed status snapshot
	EvtBusy         = "busy"          // host is mid-turn (true/false via Reason)
	EvtThinking     = "thinking"      // model is in thinking phase
	EvtCapabilities = "capabilities"  // discovered commands/skills (Payload is JSON)
)

// Capabilities is the parsed payload of an EvtCapabilities event.
type Capabilities struct {
	Commands []Candidate `json:"commands"`
	Skills   []Candidate `json:"skills"`
}

type Candidate struct {
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	Source      string      `json:"source,omitempty"`
	Args        []ArgOption `json:"args,omitempty"`
}

// ArgOption is a value the user can pass to a command (e.g. /model claude-opus-4-7).
// We only carry static, enumerable args; dynamic ones (like /cwd <path>) skip this.
type ArgOption struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// UIEvent is anything we send back to the TS host (typed user actions).
type UIEvent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	Cmd  string `json:"cmd,omitempty"`
}

const (
	UIPrompt = "prompt" // user submitted a prompt line
	UISlash  = "slash"  // user typed /command
	UIExit   = "exit"   // user requested exit
)

type writer struct {
	mu  sync.Mutex
	out io.Writer
}

func newWriter(out io.Writer) *writer { return &writer{out: out} }

func (w *writer) send(ev UIEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	b = append(b, '\n')
	_, _ = w.out.Write(b)
}

type hostMsg struct{ ev HostEvent }

// readEvents emits HostEvent messages on the returned channel until stdin EOF.
func readEvents(in io.Reader) <-chan HostEvent {
	ch := make(chan HostEvent, 64)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(in)
		sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var ev HostEvent
			if err := json.Unmarshal(line, &ev); err != nil {
				ch <- HostEvent{Type: EvtError, Message: "invalid host event: " + err.Error()}
				continue
			}
			ch <- ev
		}
	}()
	return ch
}
