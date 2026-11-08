# Writing a device definition

[日本語](device-definition_JP.md)

The **virtual device** tab runs a pretend device that behaves the way a *definition file* says. This page explains how to write one. A definition is a small JSON file: variables (the device state), commands (what it understands and answers), notifications (what it says by itself) and connection behavior (limits, idle disconnect, start-up delay).

It is **not** a programming language: there are no expressions, scripts or regular expressions. That keeps a definition readable and safe to load.

> A virtual device behaves only as its definition says. It is a way to practice and to see how a controller copes with common device behaviors. It is **not a guarantee of how real equipment behaves**.

## The quick way: make a definition from a table

You do not have to write JSON for a first definition. On the **virtual device** tab, press **Make from a table…**. A window opens with a table that works like the command table in a device manual:

- **Command**: what the device receives, without the terminator (for example `PWR?`).
- **Reply**: what the device answers (for example `PWR on`). Leave it empty for a command the device accepts **silently**.

Above the table you choose the **name**, **TCP or UDP**, the **terminator** (CR, LF or CR+LF) and, for TCP, the **message on connect** (optional). You can also set the reply to an **unknown command**.

- The terminator you chose is added to the end of every reply, of the message on connect and of the unknown-command reply. Do not write it in a cell: a terminator such as `[CR]` at the end of a cell is reported as a mistake.
- Notation such as `[TAB]` or `[LF]` works inside a reply, as in the controller.
- Everything you type is literal text. `{`, `}` and `*` are not special here (they are in a JSON definition).
- Spaces around a command are ignored. Two rows with the same command are a mistake: the first one would always win.
- **Paste rows from a manual table** takes lines copied from a spreadsheet or a manual: one command per line, the command and the reply separated by a tab. A terminator written at the end of a cell is removed.
- **Add to the controller's saved commands** (below the table) also saves the table's commands as saved commands of a controller device, so you type the manual's table only once. A row with an empty reply is saved as **This command gets no reply**. Choose a saved device or a new one (a name, a target and a port; while the virtual device is running its port is filled in). Sent from the Controller tab, each command makes the virtual device answer as the table says: the characters of a cell are sent exactly as you typed them (only the spaces at the start and the end of a command are dropped). A command whose name already exists in the target device is skipped, never overwritten, and the result says how many were added and skipped.
- The **resulting definition (JSON)** on the right changes as you edit. It is exactly what **Use this definition** loads and what **Save as…** writes, so you can learn the format from it. **Save as…** offers the `samples` folder next to the program (when it exists), so the saved file appears in the **Definition** list after **Reload list**.

**Load a definition…** fills the table from an existing JSON definition when it contains only what the table can represent: a name, TCP or UDP, one of the three terminators, an optional message on connect, literal commands with one fixed reply (or silence), and an optional fixed reply to unknown commands. If the definition has state, variables, conditions, delays, notifications, several replies, custom framing or any other information the table cannot preserve, the app rejects the whole load and lists the reasons; it never loads only part and silently drops the rest.

A table covers fixed replies only. For a device that has state (the reply to `PWR?` changes after `PWR 1`), conditions, notifications or connection quirks, write the JSON described on the rest of this page. You can start from a file saved here and edit it in a text editor.

## Samples and your own definitions

The `samples` folder next to the program holds the definitions that come with the program as plain files. Open them to see how a definition is written. Copy one, change it, and save it in the same folder (a file name of letters, digits, `.`, `_` and `-` ending in `.json`, at most 64 characters, under 1 MiB): after **Reload list** in the device tab it appears in the **Definition** list. A file that cannot be used (broken JSON, no `name`) is listed with the reason and cannot be chosen; a file that is valid JSON but breaks the rules below is reported with the position of every problem when you load it. If there is no `samples` folder, the built-in samples are used; an existing folder is used on its own, even when empty. You can also load any definition file from anywhere with **Choose a file…**.

## A first definition

```json
{
  "schemaVersion": 1,
  "name": "My first device",
  "framing": { "terminator": "cr" },
  "greeting": "HELLO[CR]",
  "variables": {
    "power": { "type": "enum", "values": ["standby", "on"], "initial": "standby" }
  },
  "commands": [
    { "pattern": "PWR ?", "reply": "PWR {var.power}[CR]" },
    {
      "pattern": "PWR {state}",
      "capture": { "state": { "map": { "0": "standby", "1": "on" } } },
      "do": { "set": { "power": "{capture.state}" } },
      "reply": null,
      "invalid": { "reply": "ERR 1[CR]" }
    }
  ],
  "notifications": [
    { "when": { "var": "power", "changes": true }, "send": "EVT PWR {var.power}[CR]" }
  ],
  "unknown": { "reply": "ERR 2[CR]" }
}
```

Choose **Choose a file…** in the virtual device tab (or load one of the bundled samples, such as **Sample quirky player**, to see more features), then **Start**, and connect to it from the controller tab. Try `PWR ?[CR]`, `PWR 1[CR]`, `PWR 7[CR]` and `HELLO?[CR]` and watch the log on both sides.

What happens: `PWR ?` answers with the state; `PWR 1` changes the state and says **nothing** (many devices stay silent on success), but the notification is sent; `PWR 7` is not in the `map`, so the `invalid` reply `ERR 1` is sent and nothing changes; an unknown command gets `ERR 2`.

## Top-level fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Always `1`. |
| `transport` | Optional: `"tcp"` (default) or `"udp"`. For UDP see [Using UDP](udp.md): a datagram is a message, senders are tracked instead of connections, and `greeting` is not allowed. |
| `name`, `description` | Shown in the app (name 1-100 characters, description up to 500). |
| `framing.terminator` | `cr`, `lf` or `crlf`. A *message* is the bytes before the terminator. In `crlf` mode only the exact pair CR LF ends a message. A message longer than 4096 bytes is discarded and answered as unknown. |
| `greeting` | Optional text sent right after a connection is accepted: the message on connect. Not allowed with `"transport": "udp"` (there is no connection to send it on). |
| `connection` | Limits and timing (see below). |
| `variables` | The device state. |
| `commands` | What the device understands, in order. |
| `notifications` | Messages the device sends when a variable changes. |
| `unknown` | The reply to anything no command matches (`{ "reply": ... }`). Leave it out for silence. |

Unknown fields are errors, so a typo is reported instead of silently ignored.

## Variables

Names are lowercase letters, digits and `_`, starting with a letter (up to 32 characters). Every variable needs an `initial` value.

| `type` | Extra fields | Notes |
|---|---|---|
| `enum` | `values`: 1-64 distinct non-empty strings | The value must be one of them. |
| `int` | `min`, `max` (optional) | A whole number. |
| `bool` | none | `true` / `false`. |
| `string` | `maxLength` (up to 64) | Text. |

## Commands

Each command has a `pattern`, and optionally `capture`, `when`, `do`, `reply`, `delayMs`, `otherwise`, `invalid` and `caseInsensitive`.

### Patterns

A pattern is matched against the **whole** message (as UTF-8 text):

- Ordinary text must match exactly (`PWR ?`). Spaces count.
- `{name}` captures **one or more characters without spaces**. The capture ends at the **earliest** place where the next literal text starts.
- `*` matches any text (spaces allowed) and captures nothing. One `*` per pattern.
- Write `{{`, `}}` and `**` for a literal `{`, `}` and `*`.
- Two captures (or a capture and a `*`) must have literal text between them. At most 4 captures per pattern.
- `"caseInsensitive": true` ignores the case of A-Z in the *literal* text only. Captured text keeps its case.

**The first command whose pattern matches is used; later ones are not tried.** So put the more specific pattern first:

```json
{ "pattern": "PWR ?",         "reply": "PWR {var.power}[CR]" },
{ "pattern": "PWR {state}", "...": "..." }
```

If `PWR {state}` came first, it would capture `?` from `PWR ?`... and fail its checks. This is the most common mistake.

### Captures and `map`

`"capture": { "state": { "map": { "0": "standby", "1": "on" } } }` turns the captured text into another value (a number meaning, as manuals often have). The captured text must be exactly one of the keys, otherwise the command takes the `invalid` path.

### `when`, `do` and the three outcomes

- `when` is a list of conditions that must all hold: `{ "var": "power", "is": "on" }`, `isNot`, `in: [...]`, or `min` / `max` for integers. Values are written as ordinary JSON values (not as `{capture...}` references).
- `do.set` changes variables: `{ "set": { "input": "{capture.n}" } }` or a fixed value such as `{ "set": { "power": "on" } }`. A value taken from a capture must be written as **exactly** `"{capture.NAME}"`.
- A captured value is converted to the variable's type: `int` accepts `0`, `5`, `-3` but **not** `007`, `+1` or `1e3`; it must also be inside `min`..`max`. `enum` must equal one of its values. If anything does not fit, **nothing changes** (all `set` entries are applied together or not at all) and the `invalid` handler runs.
- Handlers: `reply` (success), `otherwise` (a `when` condition failed), `invalid` (a value did not fit). If `otherwise` / `invalid` is missing, the `unknown` reply is used. `"reply": null` (or leaving `reply` out) means **silence**, like a device that does not confirm.

### Replies

A reply is a string, or an array of strings that are joined (handy for several lines). It can use:

- `{var.NAME}` - the current value of a variable (after this command's changes);
- `{capture.NAME}` - a captured value;
- notation such as `[CR]`, `[LF]`, `0x0D`, `\r` - written in your fixed text only. A value that happens to contain `[CR]` is sent as text, not as a CR.
- `{{` and `}}` for literal braces.

`delayMs` (0-60000) makes the device answer slowly. A delayed reply holds up the replies behind it (the device handles one thing at a time).

## Notifications

```json
"notifications": [
  { "when": { "var": "power", "changes": true }, "send": "EVT PWR {var.power}[CR]", "to": "all" }
]
```

The message is sent when the variable's value **actually changes** (setting the same value again sends nothing). `to` is `all` (every connected controller, including the sender; the default) or `sender`. A notification follows the command's reply. Notifications can only mention `{var.NAME}`.

## Connection behavior

All fields are optional. With `"transport": "udp"` the same fields count **senders** (address and port) instead of connections: `maxConnections` is how many are served at once (datagrams of others are ignored, whatever `overLimit` says), `idleTimeoutMs` is how long a silent sender is remembered (300 seconds when 0), and `idleBehavior` always means "forget the sender".

| Field | Meaning |
|---|---|
| `maxConnections` | How many controllers may be connected at once (1-32, default 1). |
| `overLimit` | `refuse`: close the extra connection at once. `accept_then_close`: send it the message on connect, then close. (A listening port cannot truly refuse one client, so both accept first.) |
| `idleTimeoutMs` | If the controller sends **no complete command** for this long (1000-3600000; 0 = never), `idleBehavior` happens. TCP keepalive does **not** count: the point of this setting is that some devices drop quiet connections even when the network is fine. |
| `idleBehavior` | `close`: close the connection. `stop_responding`: stay connected but never answer again on that connection (the state still changes). |
| `startupQuietMs` | Connections made in the first moments after **Start** are closed at once without a message on connect, like a device that is still booting (0-600000). |
| `minCommandIntervalMs` | A command that arrives sooner than this after the previous one is ignored. |

## Limits

Commands 500, notifications 100, variables 64, pattern length 256, message 4096 bytes, reply 4096 bytes, file 1 MiB, nesting depth 16.

## When the file has a mistake

The app lists every problem with its **position** as a JSON Pointer, for example `/commands/2/do/set/input` means "the `input` entry of `set`, in the command at index 2". Fix the file and choose it again.

## What it cannot do yet

UDP broadcast and multicast; login or challenge-response handshakes; regular expressions; scripts or arithmetic (for example "add one"); events that happen by themselves without a command (a front-panel button); messages without a terminator (fixed length, length prefix); more than one listening port at a time.

## While it runs

- **Listen on**: `127.0.0.1` (this PC only, the default) or `0.0.0.0` (the whole network). The second asks for confirmation and shows a warning, because other machines can connect. Your firewall may ask for permission the first time.
- **Port**: `0` picks a free one. Otherwise use 1024-65535.
- **Fault injection**: drop the next N replies, delay every reply, stop responding (mute), or close all connections now. They help you see how a controller behaves when a device misbehaves.
