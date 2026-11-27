import { accountEmail, loginPassword } from "./login.js";
import { catalogPhoto, setCatalogAccess } from "./catalog.js?v=dashboard-1";
import { menus, photos } from "./menu-data.js";
import { programStatus, googleCalendarUrl, calendarHref, animateChange, drinkGroups, tableZones } from "./event.js?v=dashboard-1";
import { supabaseUrl, supabasePublishableKey } from "./config.js?v=20261127-catalog";
import { drinkPreferences, orderMetrics, tablePortions } from "./overview.js";

const budget = 39000;
const guestCount = 13;
const defaultSeats = [0, 3, 4, 12, 11, 6, 5, 1, 2, 7, 9, 10, 8];
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
function setConnectionStatus(value) {
  setText("status", value);
  setText("session-status", value);
}
const nameOf = id => snapshot?.guests.find(guest => guest.id === id)?.name || "Гость " + (id + 1);
const blankDraft = () => ({ adjustments: new Map(), fee: 0 });
const drafts = menus.map(blankDraft);
const localExtras = [];
const wish = get("wish-form");
const fields = wish.elements;
let selectedMenu = 0;
let selectedStage = 0;
let selectedSeat = 0;
let selectedZone = 1;
let selectedTable = 0;
let seatFilter = "";
let snapshot = null;
let planDraft = null;
let wishRevision = 0;
let wishDirty = false;
let client;
let userId = null;
let channel = null;
let syncSequence = 0;
let publishing = false;

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
  if (snapshot) renderOverview();
}

function overviewMeter(label, amount, max, value) {
  const row = element("div", null, "overview-meter");
  const heading = element("div", null, "meter-label");
  heading.append(element("span", label), element("strong", value));
  const bar = element("meter");
  bar.min = 0;
  bar.max = Math.max(1, max);
  bar.value = amount;
  bar.setAttribute("aria-label", label);
  row.append(heading, bar);
  return row;
}

function renderOverview() {
  const stages = menus[selectedMenu][0];
  const metrics = orderMetrics(stages.map((_, i) => rowsFor(selectedMenu, i)), rowsFor(selectedMenu, 6), drafts[selectedMenu].fee);
  const fund = snapshot.admin ? snapshot.funding : null;
  const money = get("payments");
  money.replaceChildren();
  if (fund?.records) {
    const parties = fund.records.filter(record => record.method != null);
    const collected = parties.reduce((sum, record) => sum + record.amount, 0);
    const by = method => parties.filter(record => record.method === method).reduce((sum, record) => sum + record.amount, 0);
    const attendance = (parties.length / guestCount).toLocaleString("ru-RU", { style: "percent", maximumFractionDigits: 1 });
    money.append(overviewMeter("Собрано · " + parties.length + " из " + guestCount + " гостей", collected, budget,
      rubles(collected) + " / " + rubles(budget)),
      element("p", attendance + " · переводы " + rubles(by("transfer")) + " · наличные " + rubles(by("cash")), "muted"),
      element("p", "Осталось собрать " + rubles(Math.max(budget - collected, 0)) + " · расходы не зафиксированы.", "muted"));
    const pending = fund.records.filter(record => record.method == null);
    if (pending.length) money.append(element("p", "Нет отметки об оплате · " + pending.map(record => nameOf(record.guest_id)).join(", "), "muted"));
  }
  const cards = [
    ["Гостей", String(guestCount), "Два стола · 7 и 6 мест"],
    ["Бюджет", rubles(budget), rubles(budget / guestCount) + " с участника"],
    ["Смета", rubles(metrics.total), "Вариант " + (selectedMenu + 1) + " · " + menuNames[selectedMenu]],
    ["Еда на гостя", currency.format(metrics.weight / guestCount) + " г", "По указанным граммовкам"]
  ];
  get("overview-facts").replaceChildren(...cards.map(([label, value, caption]) => {
    const card = element("div", null, "overview-fact");
    card.append(element("span", label), element("strong", value), element("small", caption, "muted"));
    return card;
  }));
  get("estimate").replaceChildren(...["Блюда", "Алкоголь", "Безалкогольные", "Сервисный сбор"].map((label, i) =>
    overviewMeter(label, metrics.categories[i], metrics.total, rubles(metrics.categories[i]))));
  const weight = get("serving-analytics");
  weight.replaceChildren(element("p", (metrics.weight / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " кг еды всего", "overview-total"),
    ...stages.map(([time, label], i) => {
      const row = overviewMeter(time.slice(0, 5) + " · " + label, metrics.weights[i], Math.max(...metrics.weights),
        metrics.weights[i] ? currency.format(metrics.weights[i] / guestCount) + " г/гостя" : "—");
      const link = element("a", "Открыть подачу");
      link.href = "#program";
      link.addEventListener("click", () => selectServing(i));
      row.append(link);
      return row;
    }));
  if (metrics.missingWeights) weight.append(element("p", "Без данных о весе: " + metrics.missingWeights + " позиций.", "muted"));
  const preferences = get("drink-analytics");
  if (fund?.records) {
    preferences.replaceChildren(...Object.entries(drinkPreferences).map(([key, label]) => {
      const guests = fund.records.filter(record => record.drink_tags.includes(key));
      const row = overviewMeter(label, guests.length, guestCount, String(guests.length));
      if (guests.length) row.append(element("small", guests.map(record => nameOf(record.guest_id)).join(", "), "muted"));
      return row;
    }), element("p", "Один гость может выбрать несколько напитков.", "muted"));
  } else {
    preferences.replaceChildren(...Object.entries(drinkGroups).map(([key, label]) => {
      const count = snapshot.guests.filter(guest => guest.drink_group === key).length;
      return overviewMeter(label, count, guestCount, String(count));
    }));
  }
  const issues = [
    snapshot.plan.menu == null ? "Окончательное меню ожидает утверждения." : "Утверждён вариант " + (snapshot.plan.menu + 1) + ".",
    metrics.total > budget ? "Смета выше бюджета на " + rubles(metrics.total - budget) + "." : "Резерв по смете — " + rubles(budget - metrics.total) + ".",
    ...(selectedMenu < 3 ? ["Исходные предложения Алексеевой на 14 порций. Проверьте количества на 13 гостей."] : []),
    ...(selectedMenu === 1 ? ["В исходном расчёте варианта 2 расхождение 320 ₽."] : []),
    "Объём и цену бутылок водки уточнить у ресторана.",
    ...(fund?.records ? [metrics.total > fund.records.reduce((sum, record) => sum + record.amount, 0)
      ? "До оплаты этой сметы из собранных взносов не хватает " + rubles(metrics.total - fund.records.reduce((sum, record) => sum + record.amount, 0)) + "."
      : "Собранных взносов хватает на выбранную смету."] : []),
    ...(snapshot.admin ? ["Пожеланий сохранено · " + snapshot.wishes.length + " из " + guestCount + "."] : [])
  ];
  get("overview-checks").replaceChildren(...issues.map(line => element("li", line)));
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
  const source = photos[name] || catalogPhoto(name);
  const placeholder = () => {
    const node = element("span", "·", "dish-placeholder");
    node.setAttribute("aria-hidden", "true");
    return node;
  };
  const visual = source ? element("img") : placeholder();
  if (source) {
    visual.src = source;
    visual.alt = name;
    visual.loading = "lazy";
    visual.width = 72;
    visual.height = 72;
    visual.addEventListener("error", () => visual.replaceWith(placeholder()), { once: true });
  }
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
    const estimate = orderMetrics(steps.map((_, stage) => rowsFor(i, stage)), rowsFor(i, 6), drafts[i].fee);
    choice.append(element("small", "Вариант " + (i + 1)), element("strong", menuNames[i]));
    if (snapshot?.menu_authors[i]) choice.append(element("small", snapshot.menu_authors[i]));
    choice.append(element("span", rubles(estimate.total)), element("small", currency.format(estimate.weight / guestCount) + " г/гостя"));
    return choice;
  }));
  get("stages").replaceChildren(...stages.map(([time, title], i) => {
    const choice = button(null, () => {
      selectServing(i, get("stages"));
    }, i === selectedStage);
    choice.append(element("small", time), element("strong", title), element("span", null, "stage-phase"));
    const total = costs(rowsFor(selectedMenu, i));
    if (total) choice.append(element("small", rubles(total), "stage-cost"));
    return choice;
  }));
  updateProgramClock();
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

function updateProgramClock() {
  const state = programStatus(menus[selectedMenu][0], Date.now());
  setText("program-clock", state.note);
  [...get("stages").children].forEach((control, i) => {
    const phase = state.phases[i];
    control.dataset.phase = phase;
    control.querySelector(".stage-phase").textContent = phase === "live" ? "Сейчас"
      : phase === "done" ? "Завершено" : state.next === i ? "Следом" : "";
  });
}

function selectServing(index, focusGroup) {
  selectedStage = index;
  selectedZone = 1;
  renderMenu();
  renderSeating();
  focusGroup?.children[index].focus({ preventScroll: true });
  animateChange(focusGroup === get("stages") ? get("stage") : get("table-detail"));
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
  const serving = get("table-serving");
  serving.replaceChildren(...menus[selectedMenu][0].map(([time, title], index) => new Option(time + " · " + title, index)));
  serving.value = selectedStage;
  const groupOf = id => {
    const record = snapshot?.guests.find(person => person.id === id);
    const group = record?.drink_group || record?.profile?.[2];
    return Object.hasOwn(drinkGroups, group) ? group : "unknown";
  };
  const filters = [["", "Все места"], ...Object.entries(drinkGroups)];
  const filterControls = filters.map(([value, label], index) => {
    const count = value ? order.filter(id => groupOf(id) === value).length : order.length;
    const chip = button(label + " · " + count, () => {
      seatFilter = value;
      renderSeating();
      get("seat-filter").children[index].focus({ preventScroll: true });
    }, seatFilter === value);
    chip.dataset.drink = value;
    return chip;
  });
  get("seat-filter").replaceChildren(...filterControls);
  get("my-seat").hidden = !snapshot;
  const focusSeat = index => get("seats").querySelector('[data-seat="' + index + '"]')?.focus({ preventScroll: true });
  const buttons = order.map((id, index) => {
    const group = groupOf(id);
    const control = button(null, () => {
      selectedSeat = index;
      selectedTable = index < 7 ? 0 : 1;
      renderSeating();
      focusSeat(index);
      animateChange(get("guest-card"));
    }, index === selectedSeat);
    control.className = "seat";
    control.dataset.seat = index;
    control.dataset.drink = group;
    control.classList.toggle("seat-muted", Boolean(seatFilter && seatFilter !== group));
    control.classList.toggle("seat-own", id === snapshot?.member);
    control.setAttribute("aria-label", "Место " + (index + 1) + " · " + nameOf(id) + " · " + drinkGroups[group]
      + (id === snapshot?.member ? " · Моё место" : ""));
    const number = element("span", index + 1, "seat-number");
    control.append(number, element("strong", nameOf(id)));
    return control;
  });
  const zones = tableZones(rowsFor(selectedMenu, selectedStage), rowsFor(selectedMenu, 6));
  const zoneLabels = ["Без алкоголя", "Блюда", "Другие напитки"];
  const tables = [[0, 4, 7], [7, 10, 13]].map(([start, middle, end], table) => {
    const room = element("section", null, "seating-table");
    const top = element("div", null, "seat-row seat-row-top");
    const bottom = element("div", null, "seat-row seat-row-bottom");
    top.append(...buttons.slice(start, middle));
    bottom.append(...buttons.slice(middle, end).reverse());
    const surface = element("div", null, "table banquet-table");
    const zoneControls = element("div", null, "table-zones");
    zones.forEach((zone, index) => {
      const rows = tablePortions(zone.rows, table).filter(row => row[1] > 0);
      const control = button(null, () => {
        selectedTable = table;
        selectedZone = index;
        renderSeating();
        get("seats").querySelector('[data-zone="' + table + "-" + index + '"]').focus({ preventScroll: true });
        animateChange(get("table-detail"));
      }, index === selectedZone && table === selectedTable);
      control.className = "platter";
      control.dataset.zone = table + "-" + index;
      control.setAttribute("aria-label", "Стол " + (table + 1) + " · " + zone.name);
      const source = rows.map(([name]) => photos[name] || catalogPhoto(name)).find(Boolean);
      if (source) {
        const image = element("img");
        image.src = source;
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.width = 40;
        image.height = 40;
        image.addEventListener("error", () => image.remove(), { once: true });
        control.append(image);
      }
      control.append(element("strong", zoneLabels[index]), element("small", rows.length ? rows.length + " поз." : "—"));
      zoneControls.append(control);
    });
    surface.append(zoneControls);
    const heading = element("h3");
    heading.append(element("span", "Стол " + (table + 1)), element("small", (end - start) + " мест"));
    room.append(heading, top, surface, bottom);
    return room;
  });
  get("seats").replaceChildren(...tables);
  const tableDetail = get("table-detail");
  const zone = zones[selectedZone];
  const portions = tablePortions(zone.rows, selectedTable).filter(row => row[1] > 0);
  tableDetail.replaceChildren(element("h3", "Стол " + (selectedTable + 1) + " · " + zone.name),
    element("p", "Пример сервировки пропорционально числу мест.", "muted"));
  if (portions.length) {
    const list = element("ul");
    for (const [name, quantity, , grams] of portions) {
      list.append(element("li", name + " × " + quantity + (grams ? " · " + grams + " г/порция" : "")));
    }
    tableDetail.append(list);
  } else tableDetail.append(element("p", "Для этой зоны в текущем меню нет позиций."));
  setText("seats-status", planDraft ? "Черновик организатора. Для участников действует опубликованная схема."
    : snapshot?.plan.revision ? "Утверждённая рассадка. Выберите место для просмотра."
    : "Предварительная схема на 13 мест. Выберите место, чтобы открыть карточку.");
  const card = get("guest-card");
  card.replaceChildren(element("h3", "Место " + (selectedSeat + 1) + " · " + (guest?.profile?.[0] || nameOf(guestId))));
  if (guest) card.append(element("p", drinkGroups[groupOf(guestId)], "muted"));
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
    location.hash = "wishes";
    showView(false);
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
      selectedTable = index < 7 ? 0 : 1;
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

function describeWish(wish) {
  return [
    wish.seat == null ? "" : "Место " + wish.seat,
    wish.neighbor == null ? "" : "Сосед · " + nameOf(wish.neighbor),
    wish.menu == null ? "" : "Вариант меню " + (wish.menu + 1),
    wish.salad, wish.hot, wish.note
  ].filter(Boolean);
}

function showView(scroll = true) {
  const raw = location.hash.slice(1);
  const target = ["overview", "menu", "program", "seating", "wishes", "organizer", "history", "catalog"].includes(raw)
    && (raw !== "organizer" || snapshot?.admin) ? raw : "overview";
  const panel = get(target);
  const view = panel.dataset.view;
  document.querySelectorAll("[data-view]").forEach(section => {
    section.classList.toggle("view-off", section.dataset.view !== view);
  });
  document.querySelectorAll("[data-nav]").forEach(link => {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  if (snapshot && view === "catalog") void setCatalogAccess(true);
  if (snapshot && scroll) {
    if (raw && target !== "overview") panel.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0, behavior: "instant" });
    if (raw) animateChange(panel);
  }
}

window.addEventListener("hashchange", () => showView());

function renderOnline() {
  const member = Boolean(snapshot);
  const entering = member && get("workspace").hidden;
  get("entrance").hidden = member;
  get("workspace").hidden = !member;
  get("login").hidden = Boolean(userId);
  get("switch-account").hidden = !userId || member;
  get("logout").hidden = !userId;
  get("refresh").hidden = !userId;
  get("wishes").hidden = !member;
  get("organizer").hidden = !snapshot?.admin;
  get("organizer-link").hidden = !snapshot?.admin;
  get("history").hidden = !member;
  get("edit-plan").disabled = Boolean(planDraft);
  get("discard-plan").disabled = !planDraft || publishing;
  get("publish").disabled = !planDraft || publishing;
  if (!member) {
    void setCatalogAccess(false);
    get("review").replaceChildren();
    get("events").replaceChildren();
    get("votes").replaceChildren();
    get("payments").replaceChildren();
    get("drink-analytics").replaceChildren();
    wish.reset();
    return;
  }
  if (entering) {
    showView();
    if (!location.hash) get("workspace-title").focus({ preventScroll: true });
  }

  if (!wishDirty) loadWish();
  renderOverview();
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
      : event.kind === "layout" ? "Обновлена предварительная схема столов" : "Сохранены пожелания · редакция " + event.revision;
    const label = eventTime.format(new Date(event.at)) + " · " + action + (event.actor ? " · " + event.actor : "");
    if (!event.after || (event.kind !== "wish" && !event.before)) return element("li", label);
    const entry = element("li");
    const details = element("details");
    const list = element("ul");
    const changes = event.kind === "wish" ? describeWish(event.after) : describeChanges(event.before, event.after);
    list.append(...(changes.length ? changes : ["Поля пожелания оставлены пустыми."]).map(change => element("li", change)));
    if (event.kind === "wish" && event.before) {
      const previous = element("details");
      const beforeList = element("ul");
      beforeList.append(...describeWish(event.before).map(change => element("li", change)));
      previous.append(element("summary", "Предыдущая редакция"), beforeList);
      const previousItem = element("li");
      previousItem.append(previous);
      list.append(previousItem);
    }
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
    const { error: signOutError } = await client.auth.signOut({ scope: "local" });
    if (owner !== userId) return;
    if (!signOutError) switchUser(null);
    setConnectionStatus("Сеанс не связан с участником банкета. Войдите снова или свяжитесь с организатором.");
    renderOnline();
    renderMenu();
    renderSeating();
    return;
  }
  if (error) {
    setConnectionStatus("Связь с базой прервана. Проверьте подключение и обновите страницу.");
    return;
  }
  const previous = snapshot;
  snapshot = data;
  if (!snapshot.admin) planDraft = null;
  setConnectionStatus((snapshot.admin ? "Организатор" : "Участник") + " · " + nameOf(snapshot.member));
  if (JSON.stringify(previous) === JSON.stringify(data)) return;
  if (!previous || (!planDraft && previous.plan.revision !== snapshot.plan.revision)) usePlan(snapshot.plan);
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
  setConnectionStatus(userId ? "Загружаем данные банкета…" : "Введите фамилию и пароль.");
  if (!userId) {
    drafts.splice(0, drafts.length, ...menus.map(blankDraft));
    localExtras.length = 0;
    selectedMenu = 0;
    selectedStage = 0;
    selectedSeat = 0;
    seatFilter = "";
    selectedZone = 1;
    selectedTable = 0;
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

let clientLoading;
async function connect() {
  if (client) return client;
  clientLoading ??= (async () => {
    if (!configReady()) throw Error("Supabase configuration unavailable");
    if (!globalThis.supabase?.createClient) {
      await new Promise((resolve, reject) => {
        const script = element("script");
        script.src = "vendor/supabase.js";
        script.onload = resolve;
        script.onerror = () => { script.remove(); reject(Error("Supabase SDK unavailable")); };
        document.head.append(script);
      });
    }
    client = globalThis.supabase.createClient(supabaseUrl, supabasePublishableKey, {
      auth: { storage: sessionStorage, persistSession: true, detectSessionInUrl: false, autoRefreshToken: true }
    });
    client.auth.onAuthStateChange((_event, session) => setTimeout(() => switchUser(session), 0));
    return client;
  })().catch(error => { clientLoading = undefined; throw error; });
  return clientLoading;
}

function startOnline() {
  const login = get("login");
  const toggle = get("toggle-password");
  const password = login.elements.password;
  const showPassword = visible => {
    password.type = visible ? "text" : "password";
    toggle.textContent = visible ? "Скрыть" : "Показать";
    toggle.setAttribute("aria-pressed", String(visible));
  };
  toggle.addEventListener("click", () => showPassword(password.type === "password"));
  login.hidden = false;
  setConnectionStatus("");
  login.addEventListener("focusin", () => { void connect().catch(() => {}); }, { once: true });
  const storageKey = "sb-" + new URL(supabaseUrl).hostname.split(".")[0] + "-auth-token";
  if (sessionStorage.getItem(storageKey)) {
    setConnectionStatus("Восстанавливаем сеанс…");
    void connect().catch(() => setConnectionStatus("Введите фамилию и пароль, чтобы повторить подключение."));
  }
  login.addEventListener("submit", async event => {
    event.preventDefault();
    const { surname } = login.elements;
    setConnectionStatus("Входим…");
    for (const control of login.elements) control.disabled = true;
    try {
      const email = await accountEmail(surname.value);
      if (!email) {
        setConnectionStatus("Введите фамилию.");
        return;
      }
      const connection = await connect();
      const { error } = await connection.auth.signInWithPassword({ email, password: loginPassword(password.value) });
      if (error) {
        setConnectionStatus(error.status === 429 ? "Слишком много попыток. Попробуйте позже."
          : "Войти не удалось. Проверьте фамилию и пароль или свяжитесь с организатором.");
      } else login.reset();
    } catch {
      setConnectionStatus("Связь с базой прервана. Попробуйте снова.");
    } finally {
      password.value = "";
      showPassword(false);
      for (const control of login.elements) control.disabled = false;
    }
  });
  const signOut = async () => {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) setConnectionStatus("Завершить сеанс не удалось. Повторите попытку.");
    else {
      switchUser(null);
      window.scrollTo(0, 0);
      login.elements.surname.focus({ preventScroll: true });
    }
  };
  get("logout").addEventListener("click", signOut);
  get("switch-account").addEventListener("click", signOut);
  get("refresh").addEventListener("click", () => void sync());
  setInterval(() => { if (!document.hidden) void sync(); }, 60000);
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
  renderSeating();
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
get("table-serving").addEventListener("change", event => selectServing(Number(event.currentTarget.value)));
get("my-seat").addEventListener("click", () => {
  if (!snapshot) return;
  const order = planDraft?.seats || snapshot.plan.seats;
  const index = order.indexOf(snapshot.member);
  if (index < 0) return;
  selectedSeat = index;
  selectedTable = index < 7 ? 0 : 1;
  seatFilter = "";
  renderSeating();
  get("seats").querySelector('[data-seat="' + index + '"]').focus();
  animateChange(get("guest-card"));
});
for (const link of document.querySelectorAll("[data-calendar]")) {
  const href = calendarHref((navigator.userAgentData?.platform || "") + " " + navigator.userAgent);
  link.href = href;
  if (href !== "banquet.ics") {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
get("google-calendar").href = googleCalendarUrl();
setInterval(() => { if (snapshot && !document.hidden) updateProgramClock(); }, 15000);

startOnline();
