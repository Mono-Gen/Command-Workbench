// Texts for the native confirmation dialogs that remain. The main process shows them itself,
// so a compromised or buggy renderer cannot skip them or change what they say.
//  - saving a command as a "query" (a query is sent without asking, so the content is approved here)
//  - turning read-only mode off
//  - starting the virtual device on all network interfaces (visible to the whole network)
// Sending needs no dialog: pressing "Send" is the confirmation.
// Public texts never name a manufacturer, model or standard; they say "some devices ...".
//
// The query dialog shows ALL bytes of every command (up to MAX_SHOWN_BYTES; the service refuses to
// save a longer query as a query), so nothing can hide behind an innocent-looking beginning.
const MAX_SHOWN_BYTES = 256;
const MAX_SHOWN_ITEMS = 20;

const TEXTS = {
  ja: {
    reasons: {
      classify_query: '「問い合わせ」は、機器の状態を変えないコマンドとして、確認なしで送れるようになります。内容が本当に読み出しだけか確認してください。',
      disable_read_only: '読み取り専用を解除すると、設定を変えるコマンドも送れるようになります。',
      bind_all: '「すべて」で待ち受けると、同じネットワークにある他の機器からも、この仮想の機器に接続できるようになります。信頼できるネットワークでだけ使ってください。',
      relay_bind_all: '「すべて」で待ち受けると、同じネットワークにある他の機器が、認証なしで転送先の機器へ任意の命令を送り、設定を変えられるようになります。通信は記録されます。信頼できるネットワークでだけ使ってください。',
      udp_spoofable: 'UDP では、送信元のアドレスを偽ることができます。他の機器が送信元を偽って送ると、この仮想の機器が第三者に返答を送ってしまうことがあります(送る量には上限があります)。',
    },
    titles: {
      classify_query: '「問い合わせ」として保存',
      disable_read_only: '読み取り専用の解除',
      bind_all: 'ネットワーク全体で待ち受け',
      relay_bind_all: '中継をネットワーク全体で待ち受け',
    },
    messages: {
      classify_query: '次のコマンドを「問い合わせ(状態を変えない)」として保存します。',
      disable_read_only: '読み取り専用を解除します。',
      bind_all: 'すべてのネットワークインターフェースで、接続の待ち受けを開始します。',
      relay_bind_all: (target) => `すべてのネットワークインターフェースで待ち受け、受けた通信をそのまま ${target} へ転送します。`,
    },
    more: (n) => `ほか ${n} 件`,
    confirmLabels: { classify_query: '保存する', disable_read_only: '解除する', bind_all: '待ち受ける', relay_bind_all: '待ち受ける' },
    cancel: 'キャンセル',
  },
  en: {
    reasons: {
      classify_query: 'A "query" can be sent without confirmation because it is treated as not changing the device. Check that the content really only reads.',
      disable_read_only: 'Turning off read-only mode allows commands that change settings to be sent.',
      bind_all: 'Listening on all interfaces lets other machines on the network connect to this virtual device. Use it only on a network you trust.',
      relay_bind_all: 'Listening on all interfaces lets any other machine on the network send any command to the target device without authentication and change its settings. The traffic is recorded. Use it only on a network you trust.',
      udp_spoofable: 'With UDP the sender address can be forged, so another machine could make this virtual device send replies to a third party (the amount is limited).',
    },
    titles: {
      classify_query: 'Save as "query"',
      disable_read_only: 'Turn off read-only mode',
      bind_all: 'Listen on the whole network',
      relay_bind_all: 'Relay on the whole network',
    },
    messages: {
      classify_query: 'The following commands will be saved as "query" (does not change the device state).',
      disable_read_only: 'Read-only mode will be turned off.',
      bind_all: 'The device will start listening for connections on all network interfaces.',
      relay_bind_all: (target) => `The relay will listen on all network interfaces and forward everything it receives to ${target}.`,
    },
    more: (n) => `and ${n} more`,
    confirmLabels: { classify_query: 'Save', disable_read_only: 'Turn off', bind_all: 'Listen', relay_bind_all: 'Listen' },
    cancel: 'Cancel',
  },
};

function hexOf(bytes) {
  const shown = Array.from(bytes.subarray(0, MAX_SHOWN_BYTES), (b) => b.toString(16).toUpperCase().padStart(2, '0'));
  // The "..." is only a safety net: the service never asks to approve more than MAX_SHOWN_BYTES.
  return bytes.length > MAX_SHOWN_BYTES ? `${shown.join(' ')} ...` : shown.join(' ');
}

// info: { reasons: ['classify_query'] | ['disable_read_only'] | ['bind_all'], items }
//   items: [{ device, name, bytes }], used by "classify_query"
function confirmDialogText(locale, { reasons, items = null, target = '' }) {
  // Japanese is the primary language, so it is also the fallback.
  const t = TEXTS[locale] ?? TEXTS.ja;
  const kind = reasons[0];

  const lines = [];
  if (items) {
    for (const item of items.slice(0, MAX_SHOWN_ITEMS)) {
      lines.push(`${item.device} / ${item.name}: ${hexOf(item.bytes)}`);
    }
    if (items.length > MAX_SHOWN_ITEMS) lines.push(t.more(items.length - MAX_SHOWN_ITEMS));
  }

  return {
    title: t.titles[kind],
    message: typeof t.messages[kind] === 'function' ? t.messages[kind](target) : t.messages[kind],
    reasonLines: reasons.map((reason) => t.reasons[reason]),
    detail: lines.join('\n'),
    confirmLabel: t.confirmLabels[kind],
    cancelLabel: t.cancel,
  };
}

module.exports = { confirmDialogText, MAX_SHOWN_BYTES };
