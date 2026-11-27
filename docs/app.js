import { menus, photos } from "./menu-data.js";
import { supabaseUrl, supabasePublishableKey } from "./config.js";

const budget = 39000;
const guestCount = 13;
const defaultSeats = [0, 3, 4, 5, 6, 11, 12, 1, 2, 7, 8, 9, 10];
const menuNames = ["Мясное меню", "Тюбетейка и манты", "Меню с овощами и соками", "Комбинированное меню"];
const menuNotes = [
  "Исходная корзина на 14 гостей. Напитки можно добавить отдельно.",
  "В исходной корзине было указано 32 110 ₽. По восстановленному составу получается 32 430 ₽.",
  "Исходная корзина на 14 гостей с соками. Алкоголь можно добавить отдельно.",
  "Меню на 13 гостей. В стоимость входят напитки по указанному сценарию."
];
const priceNotes = {
  "Водка, 0,5 л": "Рабочая цена. Объём и цену бутылки уточнить.",
  "Пиво светлое фирменное": "Цена за позицию каталога. Объём уточнить.",
  "Коктейли (общие)": "Рабочая цена. Коктейль можно выбрать по каталогу.",
  "Вода, 1 л (условно бесплатно)": "Нулевая цена при согласовании с рестораном. Вода «Аква дью» стоит 290 ₽ за позицию каталога."
};
const currency = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const eventTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short", timeStyle: "short", timeZone: "Europe/Saratov"
});
const get = id => document.getElementById(id);
const rubles = value => currency.format(value) + " ₽";
const costs = rows => rows.reduce((total, row) => total + row[1] * row[2], 0);
const bounded = (value, max) => Math.max(0, Math.min(Math.round(Number(value) || 0), max));
const setText = (id, value) => { get(id).textContent = value; };
const nameOf = id => snapshot?.guests.find(guest => guest.id === id)?.name || "Гость " + (id + 1);
const blankDraft = () => ({ adjustments: new Map(), fee: 0 });
const drafts = menus.map(blankDraft);
const localExtras = [];
const wish = get("wish-form");
const fields = wish.elements;
let selectedMenu = 0;
let selectedStage = 0;
let selectedSeat = 0;
let snapshot = null;
let planDraft = null;
let wishRevision = 0;
let wishDirty = false;
let client;
let userId = null;
let channel = null;
let syncSequence = 0;
let publishing = false;
let pendingLogin = null;
let verifyingOtp = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, action, pressed) {
  const node = element("button", label);
  node.type = "button";
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  node.addEventListener("click", action);
  return node;
}

function inputNumber(label, value, max, onChange) {
  const input = element("input");
  input.type = "number";
  input.min = "0";
  input.max = String(max);
  input.step = "1";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(bounded(input.value, max)));
  return input;
}

function rowsFor(menuIndex, stage, adjustments = drafts[menuIndex].adjustments) {
  const [stages, drinks] = menus[menuIndex];
  const source = stage === 6 ? drinks : stages[stage][3];
  return source.map((row, i) => {
    const values = adjustments.get(stage + ":" + i);
    return values ? [row[0], values[2], values[3], row[3]] : row;
  });
}

function activeTotal() {
  return Array.from({ length: 7 }, (_, stage) => costs(rowsFor(selectedMenu, stage)))
    .reduce((total, amount) => total + amount, drafts[selectedMenu].fee);
}

function renderBudget() {
  const total = activeTotal();
  const balance = budget - total;
  setText("total", rubles(total));
  setText("per-guest", rubles(total / guestCount));
  setText("balance-label", balance < 0 ? "Превышение" : "Резерв");
  setText("balance", rubles(Math.abs(balance)));
  get("balance").classList.toggle("warn", balance < 0);
  setText("extras-total", rubles(costs(localExtras)));
}

function changeDish(stage, index, quantity, price) {
  const original = rowsFor(selectedMenu, stage, new Map())[index];
  const key = stage + ":" + index;
  const adjustments = drafts[selectedMenu].adjustments;
  if (original[1] === quantity && original[2] === price) adjustments.delete(key);
  else adjustments.set(key, [stage, index, quantity, price]);
  renderMenu();
  renderSeating();
}

function dishRow(row, stage, i) {
  const [name, quantity, price, grams] = row;
  const container = element("div", null, "dish");
  const visual = photos[name] ? element("img") : element("span", "·", "dish-placeholder");
  if (photos[name]) {
    visual.src = photos[name];
    visual.alt = name;
    visual.loading = "lazy";
    visual.width = 72;
    visual.height = 72;
  } else visual.setAttribute("aria-hidden", "true");
  const info = element("div");
  info.append(element("strong", name), element("div", rubles(price) + " за порцию" + (grams ? " · ≈ " + grams + " г" : ""), "muted"));
  if (priceNotes[name]) info.append(element("small", priceNotes[name], "muted"));

  const controls = element("div", null, "controls");
  const less = button("−", () => changeDish(stage, i, Math.max(0, quantity - 1), price));
  const more = button("+", () => changeDish(stage, i, Math.min(300, quantity + 1), price));
  less.setAttribute("aria-label", "Убавить порцию — " + name);
  more.setAttribute("aria-label", "Добавить порцию — " + name);
  less.disabled = quantity === 0;
  more.disabled = quantity === 300;
  controls.append(less, element("span", quantity), more,
    inputNumber("Цена — " + name, price, 39000, next => changeDish(stage, i, quantity, next)),
    element("strong", rubles(quantity * price)));
  container.append(visual, info, controls);
  return container;
}

function renderMenu() {
  const active = document.activeElement?.getAttribute("aria-label");
  const [stages] = menus[selectedMenu];
  get("choices").replaceChildren(...menus.map(([steps, drinks], i) => {
    const choice = button(null, () => {
      selectedMenu = i;
      selectedStage = 0;
      renderMenu();
      renderSeating();
      get("choices").children[i].focus();
    }, i === selectedMenu);
    const startingTotal = steps.reduce((sum, step) => sum + costs(step[3]), costs(drinks));
    choice.append(element("small", "Вариант " + (i + 1)), element("strong", menuNames[i]));
    if (snapshot?.menu_authors[i]) choice.append(element("small", snapshot.menu_authors[i]));
    choice.append(element("span", rubles(startingTotal)));
    return choice;
  }));
  get("stages").replaceChildren(...stages.map(([time, title], i) => {
    const choice = button(null, () => {
      selectedStage = i;
      renderMenu();
      get("stages").children[i].focus();
    }, i === selectedStage);
    choice.append(element("small", time), element("strong", title), element("span", rubles(costs(rowsFor(selectedMenu, i)))));
    return choice;
  }));
  setText("menu-note", menuNotes[selectedMenu]);
  const plan = snapshot?.plan;
  setText("plan-status", plan?.menu != null
    ? "Утверждено организатором: вариант " + (plan.menu + 1) + ". Расчёты на странице можно менять в черновике."
    : "Меню ожидает утверждения организатором.");
  get("show-plan").hidden = plan?.menu == null;
  const [time, title, detail] = stages[selectedStage];
  const stageRows = rowsFor(selectedMenu, selectedStage);
  get("stage").replaceChildren(element("h3", title), element("p", time + " · " + detail),
    ...stageRows.map((row, i) => dishRow(row, selectedStage, i)),
    element("p", "Стоимость подачи — " + rubles(costs(stageRows))));
  get("drinks").replaceChildren(...rowsFor(selectedMenu, 6).map((row, i) => dishRow(row, 6, i)));
  get("fee").value = drafts[selectedMenu].fee;
  renderBudget();
  if (active && /^(Цена|Убавить порцию|Добавить порцию) — /.test(active)) {
    for (const control of document.querySelectorAll("#stage [aria-label], #drinks [aria-label]")) {
      if (control.getAttribute("aria-label") === active && !control.disabled) {
        control.focus({ preventScroll: true });
        break;
      }
    }
  }
}

function renderExtras() {
  get("extras").replaceChildren(...localExtras.map((row, i) => {
    const line = element("div", null, "extra");
    const name = element("input");
    name.setAttribute("aria-label", "Название дозаказа " + (i + 1));
    name.placeholder = "Блюдо или напиток";
    name.maxLength = 120;
    name.value = row[0];
    name.addEventListener("input", () => { row[0] = name.value; });
    line.append(name,
      inputNumber("Количество дозаказа " + (i + 1), row[1], 300, next => { row[1] = next; renderExtras(); }),
      inputNumber("Цена дозаказа " + (i + 1), row[2], 39000, next => { row[2] = next; renderExtras(); }),
      button("Удалить", () => { localExtras.splice(i, 1); renderExtras(); }));
    return line;
  }));
  renderBudget();
}

function setOptions(select, options, current, empty = "Любое") {
  select.replaceChildren(new Option(empty, ""), ...options.map(([value, label]) => new Option(label, value)));
  if (current != null) select.value = String(current);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function renderSeating() {
  const order = planDraft?.seats || snapshot?.plan.seats || defaultSeats;
  const guestId = order[selectedSeat];
  const guest = snapshot?.guests.find(person => person.id === guestId);
  const assignmentSet = planDraft?.assignments[selectedMenu]
    || (selectedMenu === snapshot?.plan.menu ? snapshot.plan.assignments : {});
  const buttons = order.map((id, index) => {
    const control = button(null, () => {
      selectedSeat = index;
      renderSeating();
      get("seats").querySelectorAll("button")[index].focus();
    }, index === selectedSeat);
    control.className = "seat";
    control.append(element("strong", index + 1), element("small", nameOf(id)));
    return control;
  });
  get("seats").replaceChildren(...buttons.slice(0, 7), element("div", "Общий банкетный стол", "table"), ...buttons.slice(7));
  setText("seats-status", planDraft ? "Черновик организатора. Для участников действует опубликованная схема."
    : snapshot?.plan.revision ? "Утверждённая рассадка. Выберите место для просмотра."
    : "Предварительная схема на 13 мест. Выберите место, чтобы открыть карточку.");
  const card = get("guest-card");
  card.replaceChildren(element("h3", "Место " + (selectedSeat + 1) + " · " + (guest?.profile?.[0] || nameOf(guestId))));
  if (guest?.profile) {
    const list = element("dl");
    ["Салаты", "Горячее", "Напитки", "Ограничения"].forEach((label, i) => {
      list.append(element("dt", label), element("dd", guest.profile[i + 3] || "—"));
    });
    card.append(list);
  }
  const ownButton = snapshot && !planDraft ? button("Предложить это место", () => {
    fields.seat.value = String(selectedSeat + 1);
    wishDirty = true;
    get("wishes").scrollIntoView({ block: "start" });
    fields.seat.focus({ preventScroll: true });
  }) : null;
  if (ownButton) card.append(ownButton);
  if (planDraft) {
    const swap = element("select");
    const label = element("label", "Поменять местами с");
    setOptions(swap, order.flatMap((id, index) => index === selectedSeat ? [] : [[index, (index + 1) + " · " + nameOf(id)]]), null, "Выберите место");
    swap.addEventListener("change", () => {
      if (swap.value === "") return;
      const index = Number(swap.value);
      [order[index], order[selectedSeat]] = [order[selectedSeat], order[index]];
      selectedSeat = index;
      renderSeating();
    });
    label.append(swap);
    card.append(label);
  }
  const allocation = get("allocation");
  allocation.replaceChildren(element("h3", "Распределение порций · вариант " + (selectedMenu + 1)));
  for (const [stage, field, labelText] of [[1, "salad", "Салат"], [2, "hot", "Первое горячее"]]) {
    const dishes = rowsFor(selectedMenu, stage, planDraft ? drafts[selectedMenu].adjustments :
      new Map((snapshot?.plan.menu === selectedMenu ? snapshot.plan.adjustments : []).map(item => [item[0] + ":" + item[1], item])));
    const picked = assignmentSet[guestId]?.[field];
    if (planDraft) {
      const select = element("select");
      const label = element("label", labelText);
      setOptions(select, dishes.map((dish, i) => [i, dish[0]]), picked, "Не выбрано");
      select.addEventListener("change", () => {
        const assignments = planDraft.assignments[selectedMenu] ??= {};
        const current = assignments[guestId] ??= {};
        if (select.value === "") delete current[field];
        else current[field] = Number(select.value);
        renderSeating();
        card.querySelectorAll("select")[field === "salad" ? 1 : 2]?.focus();
      });
      label.append(select);
      card.append(label);
    } else if (picked != null) card.append(element("p", labelText + " · " + (dishes[picked]?.[0] || "—")));
    if (Object.keys(assignmentSet).length) {
      for (const [i, dish] of dishes.entries()) {
        const count = Object.values(assignmentSet).filter(value => value[field] === i).length;
        allocation.append(element("p", dish[0] + " · " + count + " / " + dish[1] + " порций", count > dish[1] ? "warn" : ""));
      }
    }
  }
  if (!Object.keys(assignmentSet).length) allocation.append(element("p", "Распределение ожидает утверждения."));
}

function dishWishOptions(salad, hot) {
  const picked = fields.variant.value;
  const options = picked === "" ? menus : [menus[Number(picked)]];
  for (const [stage, select, current] of [[1, fields.salad, salad], [2, fields.hot, hot]]) {
    const dishes = [...new Set(options.flatMap(([steps]) => steps[stage][3].map(row => row[0])))];
    setOptions(select, dishes.map(name => [name, name]), current, "Без пожелания");
  }
}

function loadWish() {
  const current = snapshot.wishes.find(row => row.guest_id === snapshot.member);
  wishRevision = current?.revision || 0;
  wishDirty = false;
  setOptions(fields.seat, defaultSeats.map((_, i) => [i + 1, "Место " + (i + 1)]), current?.seat);
  setOptions(fields.neighbor, snapshot.guests.filter(row => row.id !== snapshot.member).map(row => [row.id, row.name]), current?.neighbor);
  setOptions(fields.variant, menuNames.map((name, i) => [i, (i + 1) + " · " + name]), current?.menu);
  dishWishOptions(current?.salad, current?.hot);
  fields.note.value = current?.note || "";
}

function describeChanges(before, after) {
  const changes = [];
  if (before.menu !== after.menu) changes.push("Меню · " + menuNames[after.menu]);
  if (before.fee !== after.fee) changes.push("Сервисный сбор · " + rubles(before.fee) + " → " + rubles(after.fee));
  after.seats.forEach((id, i) => {
    if (id !== before.seats[i]) changes.push("Место " + (i + 1) + " · " + nameOf(before.seats[i]) + " → " + nameOf(id));
  });
  if (JSON.stringify(before.adjustments) !== JSON.stringify(after.adjustments)) {
    changes.push("Порции и цены · " + after.adjustments.length + " изменённых позиций");
  }
  if (JSON.stringify(before.assignments) !== JSON.stringify(after.assignments)) {
    changes.push("Обновлено распределение блюд");
  }
  return changes.length ? changes : ["План утверждён повторно с теми же параметрами."];
}

function renderOnline() {
  const member = Boolean(snapshot);
  get("login").hidden = Boolean(userId || pendingLogin);
  get("verify-phone").hidden = !pendingLogin || Boolean(userId);
  get("logout").hidden = !userId;
  get("refresh").hidden = !userId;
  get("wishes").hidden = !member;
  get("organizer").hidden = !snapshot?.admin;
  get("history").hidden = !member;
  get("edit-plan").disabled = Boolean(planDraft);
  get("discard-plan").disabled = !planDraft || publishing;
  get("publish").disabled = !planDraft || publishing;
  if (!member) {
    get("review").replaceChildren();
    get("events").replaceChildren();
    get("votes").replaceChildren();
    wish.reset();
    return;
  }

  if (!wishDirty) loadWish();
  const wishes = snapshot.admin ? snapshot.wishes : [];
  get("votes").replaceChildren(...(snapshot.admin ? menuNames.map((name, i) =>
    element("p", "Вариант " + (i + 1) + " · " + name + " — " + wishes.filter(item => item.menu === i).length)) : []));
  get("review").replaceChildren(...wishes.map(item => {
    const info = [
      item.seat == null ? "" : "место " + item.seat,
      item.neighbor == null ? "" : "рядом с " + nameOf(item.neighbor),
      item.menu == null ? "" : "меню " + (item.menu + 1), item.salad, item.hot, item.note
    ].filter(Boolean).join(" · ");
    return element("li", nameOf(item.guest_id) + (info ? " — " + info : " — без пожеланий"));
  }));
  get("events").replaceChildren(...snapshot.events.map(event => {
    const action = event.kind === "plan" ? "Утверждён план № " + event.revision
      : "Сохранены пожелания · редакция " + event.revision;
    const label = eventTime.format(new Date(event.at)) + " · " + action + (event.actor ? " · " + event.actor : "");
    if (!event.before || !event.after) return element("li", label);
    const entry = element("li");
    const details = element("details");
    const list = element("ul");
    list.append(...describeChanges(event.before, event.after).map(change => element("li", change)));
    details.append(element("summary", label), list);
    entry.append(details);
    return entry;
  }));
  if (!snapshot.events.length) get("events").append(element("li", "Изменений пока нет."));
}

function usePlan(plan) {
  if (plan.menu == null) return;
  selectedMenu = plan.menu;
  selectedStage = 0;
  drafts[selectedMenu] = {
    fee: plan.fee,
    adjustments: new Map(plan.adjustments.map(item => [item[0] + ":" + item[1], item]))
  };
}

async function sync() {
  if (!userId) return;
  const owner = userId;
  const request = ++syncSequence;
  const { data, error } = await client.rpc("banquet_snapshot");
  if (owner !== userId || request !== syncSequence) return;

  if (error?.code === "42501") {
    snapshot = null;
    planDraft = null;
    wishDirty = false;
    setText("status", "Доступ к банкету не подтверждён. Выйдите и войдите снова или свяжитесь с организатором.");
    renderOnline();
    renderMenu();
    renderSeating();
    return;
  }
  if (error) {
    setText("status", "Связь с базой прервана. Проверьте подключение и нажмите «Обновить данные».");
    return;
  }
  const previous = snapshot;
  snapshot = data;
  if (!snapshot.admin) planDraft = null;
  setText("status", (snapshot.admin ? "Организатор" : "Участник") + " · " + nameOf(snapshot.member));
  if (JSON.stringify(previous) === JSON.stringify(data)) return;
  if (!previous) usePlan(snapshot.plan);
  renderOnline();
  if (!previous || previous.plan.revision !== snapshot.plan.revision) renderMenu();
  const focusInSeating = get("seating").contains(document.activeElement);
  if (!focusInSeating || !previous) renderSeating();
}

function switchUser(session) {
  const next = session?.user?.id || null;
  if (next === userId) return;
  userId = next;
  syncSequence++;
  snapshot = null;
  planDraft = null;
  publishing = false;
  wishDirty = false;
  wishRevision = 0;
  if (channel) void client.removeChannel(channel);
  channel = null;
  setText("wish-status", "");
  setText("publish-status", "");
  setText("status", userId ? "Загружаем данные банкета…" : "Введите номер телефона и фамилию, указанные организатору.");
  if (!userId) {
    drafts.splice(0, drafts.length, ...menus.map(blankDraft));
    localExtras.length = 0;
    selectedMenu = 0;
    selectedStage = 0;
    selectedSeat = 0;
    renderExtras();
  }
  renderOnline();
  renderMenu();
  renderSeating();
  if (userId) {
    channel = client.channel("banquet-changes")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "banquet_signal" }, () => void sync())
      .subscribe(status => { if (status === "SUBSCRIBED") void sync(); });
    void sync();
  }
}

function configReady() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey);
}

function normalizePhone(value) {
  let phone = value.trim().replace(/[\s().-]/g, "");
  if (/^8\d{10}$/.test(phone)) phone = "+7" + phone.slice(1);
  if (/^7\d{10}$/.test(phone)) phone = "+" + phone;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function startOnline() {
  const login = get("login");
  const verify = get("verify-phone");
  login.hidden = false;
  if (!configReady() || !globalThis.supabase?.createClient) {
    setText("status", "Онлайн-доступ ещё подключается. Меню, программа и смета доступны для просмотра.");
    for (const control of login.elements) control.disabled = true;
    return;
  }
  client = globalThis.supabase.createClient(supabaseUrl, supabasePublishableKey, {
    auth: { storage: sessionStorage, persistSession: true, detectSessionInUrl: false, autoRefreshToken: true }
  });
  setText("status", "Введите номер телефона и фамилию, указанные организатору.");
  client.auth.onAuthStateChange((_event, session) => {
    if (!verifyingOtp) setTimeout(() => switchUser(session), 0);
  });
  login.addEventListener("submit", async event => {
    event.preventDefault();
    const phone = normalizePhone(login.elements.phone.value);
    const surname = login.elements.surname.value.trim().normalize("NFC");
    if (!phone || !surname) {
      setText("status", "Укажите фамилию и полный номер телефона, например +7 900 000-00-00.");
      return;
    }
    for (const control of login.elements) control.disabled = true;
    try {
      const { error } = await client.auth.signInWithOtp({ phone, options: { shouldCreateUser: false, channel: "sms" } });
      if (error) {
        setText("status", "Отправить код не удалось. Проверьте номер или повторите запрос позже.");
        return;
      }
      pendingLogin = { phone, surname };
      renderOnline();
      setText("status", "Введите шестизначный код из SMS.");
      verify.elements.token.focus();
    } catch {
      setText("status", "Связь с базой прервана. Попробуйте снова.");
    } finally {
      for (const control of login.elements) control.disabled = false;
    }
  });
  get("edit-login").addEventListener("click", () => {
    pendingLogin = null;
    verify.reset();
    renderOnline();
    setText("status", "Введите номер телефона и фамилию, затем снова запросите код.");
    login.elements.phone.focus();
  });
  verify.addEventListener("submit", async event => {
    event.preventDefault();
    if (!pendingLogin || verifyingOtp) return;
    verifyingOtp = true;
    for (const control of verify.elements) control.disabled = true;
    try {
      const { phone, surname } = pendingLogin;
      const { data, error } = await client.auth.verifyOtp({ phone, token: verify.elements.token.value.trim(), type: "sms" });
      if (error || !data.session) {
        setText("status", "Код неверен или истёк. Проверьте SMS или запросите новый код.");
        return;
      }
      const confirmation = await client.rpc("banquet_confirm_surname", { entered_surname: surname });
      if (confirmation.error || confirmation.data !== true) {
        await client.auth.signOut({ scope: "local" });
        pendingLogin = null;
        renderOnline();
        setText("status", confirmation.error ? "Не удалось подтвердить доступ. Попробуйте войти ещё раз."
          : "Связать номер и фамилию с карточкой не удалось. Проверьте написание или обратитесь к организатору.");
        login.elements.surname.focus();
        return;
      }
      pendingLogin = null;
      login.reset();
      switchUser(data.session);
    } catch {
      await client.auth.signOut({ scope: "local" }).catch(() => {});
      pendingLogin = null;
      renderOnline();
      setText("status", "Связь с базой прервана. Попробуйте войти ещё раз.");
    } finally {
      verify.reset();
      for (const control of verify.elements) control.disabled = false;
      verifyingOtp = false;
    }
  });
  get("logout").addEventListener("click", async () => {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) setText("status", "Завершить сеанс не удалось. Повторите попытку.");
    else switchUser(null);
  });
  get("refresh").addEventListener("click", () => void sync());
  setInterval(() => { if (!document.hidden) void sync(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
}

wish.addEventListener("input", () => { wishDirty = true; });
fields.variant.addEventListener("change", () => dishWishOptions(fields.salad.value, fields.hot.value));
wish.addEventListener("submit", async event => {
  event.preventDefault();
  if (!snapshot) return;
  const owner = userId;
  const submit = wish.querySelector("button");
  const number = field => field.value === "" ? null : Number(field.value);
  const parameters = {
    expected_revision: wishRevision, wanted_seat: number(fields.seat), wanted_neighbor: number(fields.neighbor),
    wanted_menu: number(fields.variant), wanted_salad: fields.salad.value || null,
    wanted_hot: fields.hot.value || null, wanted_note: fields.note.value.trim()
  };
  submit.disabled = true;
  for (const field of fields) field.disabled = true;
  try {
    const { data, error } = await client.rpc("banquet_save_wish", parameters);
    if (owner !== userId) return;
    if (error?.code === "40001") {
      await sync();
      wishRevision = snapshot?.wishes.find(row => row.guest_id === snapshot.member)?.revision || 0;
      setText("wish-status", "Пожелания изменились на другом устройстве. Проверьте свой текст и нажмите «Сохранить», чтобы применить эту версию.");
    } else if (error) setText("wish-status", "Сохранить пожелания не удалось. Попробуйте снова.");
    else {
      wishRevision = data;
      wishDirty = false;
      setText("wish-status", "Пожелания сохранены.");
      await sync();
    }
  } finally {
    for (const field of fields) field.disabled = false;
  }
});

get("edit-plan").addEventListener("click", () => {
  if (!snapshot?.admin) return;
  const plan = snapshot.plan;
  planDraft = { revision: plan.revision, seats: [...plan.seats], assignments: {} };
  if (plan.menu != null) planDraft.assignments[plan.menu] = structuredClone(plan.assignments);
  usePlan(plan);
  renderOnline();
  renderMenu();
  renderSeating();
  setText("publish-status", "Черновик открыт. Места и порции можно изменить выше.");
});
get("discard-plan").addEventListener("click", () => {
  planDraft = null;
  usePlan(snapshot.plan);
  renderOnline();
  renderMenu();
  renderSeating();
  setText("publish-status", "Редактирование завершено.");
});
get("publish").addEventListener("click", async () => {
  if (!snapshot?.admin || !planDraft || publishing) return;
  const owner = userId;
  const draft = drafts[selectedMenu];
  if (activeTotal() > budget && !window.confirm("Заказ превышает бюджет. Утвердить план с превышением?")) return;
  publishing = true;
  renderOnline();
  const { data, error } = await client.rpc("banquet_publish", {
    expected_revision: planDraft.revision, approved_menu: selectedMenu, approved_seats: planDraft.seats,
    approved_adjustments: [...draft.adjustments.values()], approved_assignments: planDraft.assignments[selectedMenu] || {},
    approved_fee: draft.fee
  });
  if (owner !== userId) return;
  publishing = false;
  if (error?.code === "40001") {
    setText("publish-status", "План уже изменился. Обновите данные, завершите редактирование и начните с актуальной версии.");
    await sync();
    renderOnline();
  } else if (error) {
    setText("publish-status", "Утверждение не выполнено. Проверьте данные и подключение.");
    renderOnline();
  } else {
    planDraft = null;
    setText("publish-status", "Утверждён план № " + data + ".");
    await sync();
    renderOnline();
    renderSeating();
  }
});

get("show-plan").addEventListener("click", () => { usePlan(snapshot.plan); renderMenu(); renderSeating(); });
get("suggested-bar").addEventListener("click", () => {
  const recommended = menus[3][1];
  rowsFor(selectedMenu, 6).forEach((row, i) => {
    const fromMenu = recommended.find(drink => drink[0] === row[0]);
    if (fromMenu && fromMenu[1] > row[1]) drafts[selectedMenu].adjustments.set("6:" + i, [6, i, fromMenu[1], row[2]]);
  });
  renderMenu();
});
get("reset-menu").addEventListener("click", () => { drafts[selectedMenu] = blankDraft(); renderMenu(); renderSeating(); });
get("fee").addEventListener("change", event => {
  const value = bounded(event.currentTarget.value, budget);
  event.currentTarget.value = value;
  drafts[selectedMenu].fee = value;
  renderBudget();
});
get("add-extra").addEventListener("click", () => {
  localExtras.push(["", 1, 0]);
  renderExtras();
  get("extras").lastElementChild.firstElementChild.focus();
});
get("copy-menu").addEventListener("click", async () => {
  const lines = menu => menu.filter(row => row[1]).map(([name, amount, price]) => name + " × " + amount + " · " + rubles(amount * price));
  const output = [
    "Вариант " + (selectedMenu + 1) + " · " + menuNames[selectedMenu],
    ...menus[selectedMenu][0].flatMap(([time, title], stage) => [time + " · " + title, ...lines(rowsFor(selectedMenu, stage))]),
    "Напитки", ...lines(rowsFor(selectedMenu, 6)),
    "Сервисный сбор: " + rubles(drafts[selectedMenu].fee), "Итого: " + rubles(activeTotal())
  ].join("\n");
  try {
    await navigator.clipboard.writeText(output);
    setText("copy-status", "Заказ скопирован.");
  } catch {
    setText("copy-status", "Буфер обмена недоступен. Заказ можно сохранить через «Печать / PDF».");
  }
});
get("print").addEventListener("click", () => window.print());

renderMenu();
renderExtras();
renderSeating();
startOnline();
