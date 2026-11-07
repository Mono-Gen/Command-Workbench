// Texts for native confirmation dialogs owned by the main process.
// Listening on all network interfaces remains a user decision that the page cannot make alone.
// Public texts never name a manufacturer, model or standard; they say "some devices ...".

const TEXTS = {
  ja: {
    reasons: {
      bind_all: '「すべて」で待ち受けると、同じネットワークにある他の機器からも、この仮想の機器に接続できるようになります。信頼できるネットワークでだけ使ってください。',
      relay_bind_all: '「すべて」で待ち受けると、同じネットワークにある他の機器が、認証なしで転送先の機器へ任意の命令を送り、設定を変えられるようになります。通信は記録されます。信頼できるネットワークでだけ使ってください。',
      udp_spoofable: 'UDP では、送信元のアドレスを偽ることができます。他の機器が送信元を偽って送ると、この仮想の機器が第三者に返答を送ってしまうことがあります(送る量には上限があります)。',
    },
    titles: {
      bind_all: 'ネットワーク全体で待ち受け',
      relay_bind_all: '中継をネットワーク全体で待ち受け',
    },
    messages: {
      bind_all: 'すべてのネットワークインターフェースで、接続の待ち受けを開始します。',
      relay_bind_all: (target) => `すべてのネットワークインターフェースで待ち受け、受けた通信をそのまま ${target} へ転送します。`,
    },
    confirmLabels: { bind_all: '待ち受ける', relay_bind_all: '待ち受ける' },
    cancel: 'キャンセル',
  },
  en: {
    reasons: {
      bind_all: 'Listening on all interfaces lets other machines on the network connect to this virtual device. Use it only on a network you trust.',
      relay_bind_all: 'Listening on all interfaces lets any other machine on the network send any command to the target device without authentication and change its settings. The traffic is recorded. Use it only on a network you trust.',
      udp_spoofable: 'With UDP the sender address can be forged, so another machine could make this virtual device send replies to a third party (the amount is limited).',
    },
    titles: {
      bind_all: 'Listen on the whole network',
      relay_bind_all: 'Relay on the whole network',
    },
    messages: {
      bind_all: 'The device will start listening for connections on all network interfaces.',
      relay_bind_all: (target) => `The relay will listen on all network interfaces and forward everything it receives to ${target}.`,
    },
    confirmLabels: { bind_all: 'Listen', relay_bind_all: 'Listen' },
    cancel: 'Cancel',
  },
};

function confirmDialogText(locale, { reasons, target = '' }) {
  // Japanese is the primary language, so it is also the fallback.
  const t = TEXTS[locale] ?? TEXTS.ja;
  const kind = reasons[0];

  return {
    title: t.titles[kind],
    message: typeof t.messages[kind] === 'function' ? t.messages[kind](target) : t.messages[kind],
    reasonLines: reasons.map((reason) => t.reasons[reason]),
    detail: '',
    confirmLabel: t.confirmLabels[kind],
    cancelLabel: t.cancel,
  };
}

module.exports = { confirmDialogText };
