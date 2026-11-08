# Using UDP

[日本語](udp_JP.md)

All three tabs can speak **UDP** as well as TCP: the controller sends datagrams to a device, the virtual device answers datagrams, and the relay passes datagrams between the two and records them. This page explains what is different from TCP, how to use each tab, and what UDP cannot tell you.

> UDP gives no feedback. When nothing comes back, the program cannot tell whether the datagram was lost, the port is wrong, a firewall dropped it, or the device simply does not answer. The hints list possible causes; they are not conclusions.

## What is different from TCP

| | TCP | UDP |
|---|---|---|
| Connection | There is one; it can be refused, closed or time out. | **None.** "Connect" only prepares a socket for sending. Nothing tells you whether the device is there. |
| Message boundaries | The bytes are a stream; the terminator splits messages. | **One datagram is one message.** What is sent in one piece arrives in one piece (or not at all). |
| Delivery | Checked and repeated by the operating system. | **Not guaranteed**: a datagram can be lost, duplicated or arrive out of order. The program does not repeat or reorder anything. |
| Where the reply comes from | The same connection. | Some devices answer **from another port**, or to a **fixed port** instead of the port you sent from. |
| Size | Any. | At most **65507 bytes**. Above about **1472 bytes** a network may split the datagram or drop it. |
| Errors | Refused, reset, timed out. | A send to a closed port **succeeds** on Windows (no error is reported). |

A device that talks UDP usually treats a trailing terminator as optional. The virtual device accepts both `ID?` and `ID?[CR]`: it removes **one** terminator at the end of a datagram if there is one, and never splits a datagram into several lines.

## Controller tab

1. In the **Register a device** window set **Transport** to **UDP** and enter the address and port. Only addresses on your own network (private addresses, or this PC) are accepted. Broadcast and multicast addresses (including the broadcast address of your own network) are refused: one command would reach many devices.
2. Press **Connect**. The badge says *UDP ready (delivery not confirmed)*. That is all it means.
3. Type a command and press **Send**. One send is one datagram. An empty command cannot be sent.

Two UDP-only settings:

- **Local port.** Set it when the device always sends its replies to one fixed port. Empty or `0` picks a free port. If the port is already used, the program says so.
- **Accept replies from any source.** By default only datagrams from the target are accepted; anything else is dropped by the operating system and you never see it. If the device answers from another port, tick this to receive those replies, shown with their source. Without a connection to filter on, this also shows whatever else happens to reach that port.

Hints specific to UDP: *No reply (UDP)* (wrong port, a reply to another port, firewall, a format the device rejects such as a missing terminator, or a TCP-only device), *A reply came from another source*, *The local port cannot be used*, and *The datagram is too large*. TCP hints about refused or closed connections do not appear.

Limits that protect other equipment: at most 5 new "connections" per 10 seconds, and 100 datagrams and 256 KiB per second per socket. TCP keepalive does not apply to UDP.

## Virtual device tab

Add `"transport": "udp"` to a definition (see [Writing a device definition](device-definition.md)), or choose the definition **Sample UDP unit** from the list. The tab then listens for datagrams instead of connections.

- Each datagram is one command. The reply goes back to the **sender**, from the port the device listens on.
- Each sender (address and port) is a **source**, listed instead of connections. The device state is **shared** by all sources, as with several TCP connections. A notification addressed to `all` goes to the sources that have talked to the device recently.
- `maxConnections` limits how many sources are served at once; datagrams from further sources are **ignored** (both values of `overLimit` behave this way). `minCommandIntervalMs`, `startupQuietMs` and the fault injection work as in TCP; **Close all connections now** makes the device forget all sources.
- A source is forgotten after `idleTimeoutMs` without a datagram, or after **300 seconds** when that is `0`. Both `idleBehavior` values mean "forget the source"; it is served again at its next datagram.
- A UDP definition cannot have a `greeting`: with no connection there is nothing to send it on.
- An empty datagram is ignored.

**Listening on the whole network.** A UDP sender address can be **forged**, so another machine could make the virtual device send replies to a third party. The confirmation says so, and the program limits what it sends (about 32 KiB per second in total and 8 KiB per second per source) and what it accepts. This **reduces** the effect; it cannot remove it. Use the whole-network setting only on a network you trust.

## Relay tab

Choose **UDP** for the communication, enter the target (a device on your own network) and start. Point the controller at the relay.

- Every datagram from the controller is passed to the device **unchanged and in one piece**, and every datagram from the device is passed back to the controller that is talking to it.
- Each controller (address and port) gets its own **session** with its own connection to the device, so replies always return to the right controller. At most 8 sessions at a time and 10 new ones per second.
- A session ends **60 seconds after the controller last sent something** (traffic from the device does not extend it), and in any case after one hour. A new datagram simply starts a new session.
- The recording has **one item per datagram** and shows the kind of traffic (UDP). Like TCP recordings it contains no address or time of day. An empty datagram is passed on but not recorded. The recording holds either TCP or UDP traffic: switch only when it is empty (save or clear it first).
- **A draft cannot be made from a UDP recording yet.** The recording can be saved and loaded again.
- On the whole network, replies are limited like those of the virtual device (about 32 KiB per second in total and 8 KiB per second per session), so **a reply larger than 8 KiB is not relayed there** and the log says so. The same warning about forged sender addresses applies.

## What it cannot do yet

Broadcast and multicast (sending or receiving), resending or reordering datagrams, splitting a datagram at line ends, handshakes or logins, and drafting a definition from a UDP recording. IPv6 is not supported and is not planned.

## Troubleshooting

- **No reply.** Check the port, the cable and the firewall, then the terminator the device expects. If the manual says the device answers to a fixed port, set the **local port**. If it answers from another port, tick **Accept replies from any source**.
- **"The local port cannot be used".** Another program has that port. Choose another one or leave it empty. On Windows a program bound to the whole network and one bound to a single address can use the same port at the same time, so a conflict is only detected between identical addresses.
- **A large command is not answered.** Above about 1472 bytes the network may drop it. Keep commands short.
- **The first start asks about the firewall.** Listening on the whole network may make Windows ask for permission.
