const victoryScore = 10;

function makeTargetGrid() {
  const positions = [...Array(9).keys()];
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, 3);
}

export function openGrinch({ participant, onVictory, onBack, imageUrl = "dishes/grinch-finale.webp" }) {
  const dialog = document.createElement("dialog");
  dialog.className = "grinch-dialog";
  dialog.setAttribute("aria-labelledby", "grinch-title");
  dialog.innerHTML = `
    <header><p class="grinch-participant"></p><h2 id="grinch-title">Операция «Гринч»</h2></header>
    <section data-screen="rules">
      <p>Гринч пытается похитить праздничное меню.</p>
      <ul><li>Поразите 10 целей Гринча на радаре.</li><li>Синий союзник отнимает одно очко.</li><li>Можно играть мышью, касанием или клавиатурой. Время не ограничено.</li></ul>
      <button data-action="start">Начать испытание</button>
      <button data-action="close">Назад к пожеланиям</button>
    </section>
    <section data-screen="game" hidden>
      <div class="grinch-score"><label for="grinch-progress">Цели Гринча</label><strong role="status" id="grinch-score">0 / 10</strong></div>
      <progress id="grinch-progress" max="10" value="0"></progress>
      <div class="grinch-radar" role="group" aria-label="Цели на радаре"></div>
      <button data-action="stop">Назад к пожеланиям</button>
    </section>
    <section data-screen="victory" hidden>
      <img alt="Гринч" class="grinch-final-image" width="360" height="250">
      <h3>Вы спасли праздник!</h3>
      <p id="grinch-send" role="status"></p>
      <div class="grinch-actions">
        <button data-action="retry" hidden>Повторить отправку</button>
        <button data-action="again" hidden>Сыграть ещё раз</button>
        <button data-action="menu" hidden>Назад к меню</button>
        <button data-action="stop" class="grinch-return" hidden>Вернуться к пожеланиям</button>
      </div>
    </section>`;
  const find = selector => dialog.querySelector(selector);
  const action = name => find('[data-action="' + name + '"]');
  const radar = find(".grinch-radar");
  let score = 0;
  let phase = "rules";
  let submitted = false;
  let submitting = false;

  function show(screen) {
    phase = screen;
    for (const section of dialog.querySelectorAll("[data-screen]")) {
      section.hidden = section.dataset.screen !== screen;
    }
  }

  async function finish() {
    if (submitting || submitted || !dialog.open || phase !== "victory") return;
    submitting = true;
    action("retry").hidden = true;
    find(".grinch-return").hidden = true;
    const status = find("#grinch-send");
    status.textContent = "Отправляем пожелания…";
    try {
      await onVictory();
      if (!dialog.open) return;
      submitted = true;
      status.textContent = "Пожелания отправлены организатору. Спасибо!";
      action("again").hidden = false;
      action("menu").hidden = false;
      action("again").focus({ preventScroll: true });
    } catch (error) {
      if (!dialog.open) return;
      status.textContent = error?.message || "Не удалось отправить пожелания.";
      action("retry").hidden = error?.retryable === false;
      find(".grinch-return").hidden = false;
      (action("retry").hidden ? find(".grinch-return") : action("retry")).focus({ preventScroll: true });
    } finally {
      submitting = false;
    }
  }

  function finishGame() {
    show("victory");
    const image = find(".grinch-final-image");
    if (!image.hasAttribute("src")) image.src = imageUrl;
    if (submitted) {
      find("#grinch-send").textContent = "Пожелания уже отправлены. Спасибо за игру!";
      action("again").hidden = false;
      action("menu").hidden = false;
      action("again").focus({ preventScroll: true });
    } else void finish();
  }

  function prepareWave(focusTarget) {
    find("#grinch-score").textContent = score + " / " + victoryScore;
    find("#grinch-progress").value = score;
    const positions = makeTargetGrid();
    const targets = Array.from({ length: 9 }, (_, i) => {
      const targetIndex = positions.indexOf(i);
      if (targetIndex === -1) {
        const blank = document.createElement("span");
        blank.setAttribute("aria-hidden", "true");
        return blank;
      }
      const ally = targetIndex === 2;
      const target = document.createElement("button");
      target.type = "button";
      target.textContent = ally ? "Союзник" : "Цель";
      target.className = ally ? "grinch-target grinch-ally" : "grinch-target";
      target.setAttribute("aria-label", ally ? "Союзник" : "Цель Гринча " + (targetIndex + 1));
      target.addEventListener("click", event => {
        if (phase !== "game") return;
        score = ally ? Math.max(0, score - 1) : score + 1;
        if (score === victoryScore) finishGame();
        else prepareWave(event.detail === 0);
      });
      return target;
    });
    radar.replaceChildren(...targets);
    if (focusTarget) radar.querySelector("button")?.focus({ preventScroll: true });
  }

  function play() {
    score = 0;
    show("game");
    prepareWave(true);
  }

  find(".grinch-participant").textContent = "Участник · " + participant;
  action("start").addEventListener("click", play);
  action("again").addEventListener("click", play);
  action("retry").addEventListener("click", finish);
  action("menu").addEventListener("click", () => { dialog.close(); onBack(); });
  action("close").addEventListener("click", () => dialog.close());
  for (const item of dialog.querySelectorAll('[data-action="stop"]')) {
    item.addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
