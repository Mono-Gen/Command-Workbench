# Security policy / セキュリティについて

## Reporting a vulnerability / 脆弱性の報告

Please do **not** open a public issue for a security problem. Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Describe what you found, how to reproduce it, and which version (shown in the file name of the download) you used.

セキュリティ上の問題は、公開の Issue には書かないでください。このリポジトリの **Security** タブから **Report a vulnerability**(非公開の報告)を使ってください。見つけたこと、再現の手順、使った版(ダウンロードのファイル名に入っています)を書いてください。

## What the program does and does not do / このプログラムがすること・しないこと

- It sends and receives data **only to the addresses you enter** (TCP/UDP), or listens on this PC (`127.0.0.1`) by default. Listening on the whole network is an explicit choice that asks for confirmation.
- It has **no network features of its own**: no update check, no telemetry, nothing is uploaded. Recordings and command lists are saved only where you choose or next to the program.
- The relay and the controller (UDP) refuse targets outside your own network (private addresses). The controller (TCP) connects to **any address you type**, because real equipment can be anywhere; if the screen of the program were ever taken over, it could therefore be made to connect somewhere and send data. That is why the screen is isolated as described below.
- The screen of the program is isolated from the system (no Node.js access, a strict content security policy, and every request from the screen is checked again by the main part of the program).

- 通信先は**あなたが入力したアドレスだけ**です。待ち受けは、既定ではこの PC(`127.0.0.1`)だけで、ネットワーク全体での待ち受けは、確認つきの明示的な選択です。
- **自分からは通信しません。** 更新の確認も、利用状況の送信もなく、何もアップロードしません。記録とコマンド集は、あなたが選んだ場所か、プログラムと同じ場所にだけ保存します。
- 中継役と、UDP の制御役は、自分のネットワーク(プライベートアドレス)の外へは送りません。TCP の制御役は、実機がどこにあるか分からないため、**入力された任意のアドレス**へ接続します。もしプログラムの画面が乗っ取られた場合は、どこかへ接続してデータを送らされる可能性があります。そのため、画面は次のように隔離しています。
- プログラムの画面は、システムから隔離されています(Node.js を使えず、厳しいコンテンツセキュリティポリシーがあり、画面からの要求はすべて本体側で再検査します)。

## Supported versions / 対象の版

Only the latest release receives fixes. / 修正は、最新の版にだけ行います。

## Known limits / 既知の限界

- The program file is **not code-signed**, so Windows may warn when you start it.
- UDP sender addresses can be forged. When listening on the whole network, the virtual device and the relay limit what they send, which reduces but cannot remove reflected traffic. Use the whole-network setting only on a network you trust.
- 実行ファイルには**コード署名がない**ため、起動時に Windows が警告することがあります。
- UDP の送信元アドレスは偽れます。ネットワーク全体で待ち受けるとき、仮想の機器と中継役は送る量を制限しますが、反射される通信を減らせても、なくせません。信頼できるネットワークでだけ使ってください。
