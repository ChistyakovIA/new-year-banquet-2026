const rankingLimit = 8640000;

export function openGrinch({ participant, onVictory, onBack, loadRanking, recordResult }) {
  const dialog = document.createElement("dialog");
  dialog.className = "grinch-dialog";
  dialog.setAttribute("aria-label", "Операция «Гринч»");
  const bar = document.createElement("div");
  bar.className = "grinch-frame-bar";
  const title = document.createElement("strong");
  title.textContent = "Операция «Гринч»";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "К пожеланиям";
  bar.append(title, close);
  const frame = document.createElement("iframe");
  frame.title = "Радар и рейтинг участников";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "autoplay");
  frame.src = "game/operation-grinch.html?v=2";
  dialog.append(bar, frame);

  let port;
  let submitted = false;
  let processing = false;

  frame.addEventListener("load", () => {
    if (!dialog.open) return;
    port?.close();
    const connection = new MessageChannel();
    port = connection.port1;
    port.onmessage = async ({ data }) => {
      if (!dialog.open || !data || typeof data !== "object") return;
      if (data.type === "back" && !processing) {
        dialog.close();
        if (submitted) onBack();
        return;
      }
      if (data.type === "rank") {
        try {
          const rows = await loadRanking();
          port?.postMessage({ type: "rank", rows });
        } catch {
          port?.postMessage({ type: "rank", error: "Рейтинг временно недоступен." });
        }
        return;
      }
      if (data.type !== "finish" || processing) return;
      const { seconds, friendly, misses, score } = data.result ?? {};
      const centiseconds = Math.round(seconds * 100);
      if (score !== 10 || !Number.isFinite(seconds) || centiseconds < 1 || centiseconds > rankingLimit ||
        ![friendly, misses].every(value => Number.isInteger(value) && value >= 0 && value <= 10000)) return;
      processing = true;
      close.disabled = true;
      try {
        const [wish, rank] = await Promise.allSettled([
          submitted ? Promise.resolve() : onVictory(),
          recordResult({ centiseconds, friendly, misses })
        ]);
        if (wish.status === "fulfilled") submitted = true;
        port?.postMessage({
          type: "finish",
          saved: submitted,
          retryable: wish.status === "rejected" && wish.reason?.retryable !== false || rank.status === "rejected",
          message: submitted ? "Пожелания отправлены организатору. Спасибо!" : wish.reason?.message,
          rows: rank.status === "fulfilled" ? rank.value : null,
          rankingError: rank.status === "rejected" ? "Результат пока не записан в рейтинг." : ""
        });
      } finally {
        close.disabled = false;
        processing = false;
      }
    };
    frame.contentWindow.postMessage({ type: "grinch-init", participant }, "*", [connection.port2]);
  });
  close.addEventListener("click", () => { if (!processing) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (processing) event.preventDefault(); });
  dialog.addEventListener("close", () => { port?.close(); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}