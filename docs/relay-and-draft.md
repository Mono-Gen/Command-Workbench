# Recording traffic with the relay, and the draft definition

[日本語](relay-and-draft_JP.md)

The **relay** tab sits between a controller and a real device. The controller connects to the relay, the relay connects to the device, and everything is passed through **unchanged** while it is recorded. From a recording you can make a **draft** of a device definition (see [Writing a device definition](device-definition.md)) and try it as a virtual device.

> A draft is a starting point. It is **not a guarantee** that a virtual device behaves like the real one, and a recording can only show what happened while it was running.

> The relay can also pass **UDP** datagrams (see [Using UDP](udp.md)). A draft cannot be made from a UDP recording yet.

## Why use it

- To **see** what a real device and another program really say to each other, without reading a manual first.
- To **practice without the device** afterwards: the draft becomes a virtual device you can connect to.

## Using it

1. Open the **Relay** tab.
2. Enter the **target**: the address and port of the real device. Only devices on your own network (private addresses, or this PC) are accepted; anything else is refused with an explanation.
3. Choose **Listen on** and a **port** (`0` picks a free one) and press **Start**. A hint tells you which address and port the controller must connect to instead of the device.
4. Use your controller as usual. Both directions appear in the **Traffic log**, and the **Recording** panel counts what was recorded.
5. Press **Make a draft from this recording**. The draft lists its commands, how reliable it looks, and **Things to check**.
6. **Try it as a virtual device** loads the draft into the virtual device tab (stop a running virtual device first). **Save as definition…** writes it as a JSON file you can edit.

You can also **Save…** a recording to a file you choose, and **Load…** it again later (for example to make a draft on another day).

## What the relay promises, and what it does not

- **Promised:** the bytes of each direction arrive in the same order and without changes. A close from one side is passed on to the other, and a reply can still arrive after the controller has finished sending.
- **Not promised:** where TCP splits or joins data, and exact timing. The recording shows what the relay saw, which can differ from what each end saw. The relay uses its own connection to the device, so settings such as TCP keepalive are not passed through.
- Limits that protect your PC: 8 connections at a time, 10 new connections per second, 8 MiB of recorded data, 200,000 recorded items. When the recording is full it **stops recording but keeps forwarding**, and says so. A connection whose peer does not read for 10 seconds is cut off. If the device closes a connection and the controller never does, the relay closes it after 60 seconds.

## Safety

- **Only your own network.** The target must be a private address or this PC. The address is looked up once and then fixed, so a name cannot be changed to point somewhere else afterwards. The relay never connects to itself.
- **Listening on the whole network** (`0.0.0.0`) lets any other machine on the network send commands to the target device through the relay, without authentication. It asks for confirmation, names the address it will forward to, and keeps a warning visible. Use it only on a network you trust.
- **A recording can contain passwords and settings** exactly as they were sent. You choose where it is saved; the app never saves one by itself or uploads anything. A saved recording contains no host name, address or clock time, but its content can still reveal a lot. Check it before you share it.
- Everything above is checked by the program's main process, not by the screen. The screen never receives file paths, the recording or the definition itself.

## How the draft is made

The draft only contains what the recording shows **for certain**:

1. It guesses the **terminator** of the requests (CR, LF or CR+LF) by counting. You can choose it yourself.
2. It splits the traffic into messages and pairs each request with the reply that followed it, but **only when one request was sent at a time**. Requests sent closer together than the minimum gap (250 ms by default) are left out, because it is unclear which reply belongs to which.
3. A request that always got the same reply becomes a command with that reply (exactly as seen, including its line ending). A request that never got a reply becomes a silent command. A message that every connection started with becomes the message on connect.

Replies may end with CR, LF or CR+LF, and may even differ from one command to the next; the draft writes down the exact bytes.

### Things to check

Everything the draft could **not** decide is listed, with a count and examples:

| Item | What it means |
|---|---|
| Depends on state | The reply to a request changed between times (for example a power query before and after switching on). Left out: add variables yourself. |
| Seen once | Included, but one observation does not show that the reply is always the same. |
| Unclear which reply belongs to which | Requests came back to back, or the gap was shorter than the minimum. Left out. |
| Reply in several lines | A recording cannot tell a multi-line reply from something the device said on its own. |
| No line ending | A reply without a line ending is never treated as "no reply". Those requests are left out. |
| Cannot be read as text, too long, too many | Left out. |
| The message on connect differs | The message on connect is not included. |
| Variables | The device state is **never** guessed from a recording. |

### How reliable is it

When the recording has two or more connections, the app makes the draft from some of them and tries it on the others, and shows how many requests got the same reply. It is only a hint: requests that depend on state count against it, and the app cannot know what a real device would do with a request it has never seen.

## What it cannot do yet

UDP; login or challenge-response handshakes; changing or injecting traffic; several targets at once; guessing variables or state from a recording; messages without a terminator (fixed length, length prefix).
