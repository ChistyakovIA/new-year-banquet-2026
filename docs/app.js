import { accountEmail, loginPassword } from "./login.js";
import { catalogPhoto, loadCatalogGroups, setCatalogAccess, wishCatalog } from "./catalog.js?v=wishes";
import { menus, photos } from "./menu-data.js";
import { googleCalendarUrl, calendarHref, animateChange, drinkGroups, tableZones } from "./event.js?v=dashboard-1";
import { supabaseUrl, supabasePublishableKey } from "./config.js?v=20261127-catalog";
import { drinkPreferences, orderMetrics, tablePortions } from "./overview.js?v=layouts";
import { seatingRows, seatingReview, suggestSeats } from "./planning.js?v=wishes";
import { servingPhotos } from "./serving-photos.js";

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
let selectedMenu = null;
const comparison = new Set();
let comparisonActive = false;
let selectedStage = 0;
let selectedSeat = 0;
let selectedZone = 1;
let selectedTable = 0;
let previewTables = null;
let wishFood = {};
let wishDrinks = [];
let wishLegacyDishes = [];
let pickerSlot = "salad";
let pickerGroups = [];
let pickerRequest = 0;
let timelineKey = "";
let seatFilter = "";
let snapshot = null;
let planDraft = null;
let wishRevision = 0;
let wishDirty = false;
let wishChallenge = null;
let openingWishChallenge = false;
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

function rowsFor(menuIndex, stage, adjustments = drafts[menuIndex]?.adjustments) {
  if (menuIndex == null) return [];
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
  const total = selectedMenu == null ? null : activeTotal();
  const balance = budget - total;
  setText("total", total == null ? "—" : rubles(total));
  setText("per-guest", total == null ? "—" : rubles(total / guestCount));
  setText("balance-label", balance < 0 ? "Превышение" : "Резерв");
  setText("balance", total == null ? "—" : rubles(Math.abs(balance)));
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
  renderLayoutSummary();
  const stages = selectedMenu == null ? [] : programStages();
  const metrics = selectedMenu == null ? null :
    orderMetrics(stages.map((_, i) => rowsFor(selectedMenu, i)), rowsFor(selectedMenu, 6), drafts[selectedMenu].fee);
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
    ["Гостей", String(guestCount), visibleTables() ? layoutLabel(visibleTables()) : "Формат рассадки ещё не выбран"],
    ["Бюджет", rubles(budget), rubles(budget / guestCount) + " с участника"],
    ["Смета", metrics ? rubles(metrics.total) : "—", metrics ? menuLabel(selectedMenu) : "Меню ещё не выбрано"],
    ["Еда на гостя", metrics ? currency.format(metrics.weight / guestCount) + " г" : "—", "По указанным граммовкам"]
  ];
  get("overview-facts").replaceChildren(...cards.map(([label, value, caption]) => {
    const card = element("div", null, "overview-fact");
    card.append(element("span", label), element("strong", value), element("small", caption, "muted"));
    return card;
  }));
  get("estimate").replaceChildren(...(metrics ? ["Блюда", "Алкоголь", "Безалкогольные", "Сервисный сбор"].map((label, i) =>
    overviewMeter(label, metrics.categories[i], metrics.total, rubles(metrics.categories[i])))
    : [element("p", "Выберите вариант, чтобы увидеть смету.", "muted")]));
  const weight = get("serving-analytics");
  weight.replaceChildren(metrics ? element("p", (metrics.weight / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " кг еды всего", "overview-total")
    : element("p", "Подача и вес еды зависят от выбранного меню.", "muted"),
    ...stages.map(([time, label], i) => {
      const row = overviewMeter(time.slice(0, 5) + " · " + label, metrics.weights[i], Math.max(...metrics.weights),
        metrics.weights[i] ? currency.format(metrics.weights[i] / guestCount) + " г/гостя" : "—");
      const link = element("a", "Открыть подачу");
      link.href = "#serving-step-" + i;
      link.addEventListener("click", () => selectServing(i));
      row.append(link);
      return row;
    }));
  if (metrics?.missingWeights) weight.append(element("p", "Без данных о весе: " + metrics.missingWeights + " позиций.", "muted"));
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
    ...(metrics ? [metrics.total > budget ? "Смета выше бюджета на " + rubles(metrics.total - budget) + "." : "Резерв по смете — " + rubles(budget - metrics.total) + "."] : []),
    ...(metrics && selectedMenu < 3 ? ["Исходные предложения Алексеевой на 14 порций. Проверьте количества на 13 гостей."] : []),
    ...(selectedMenu === 1 ? ["В исходном расчёте варианта 2 расхождение 320 ₽."] : []),
    "Объём и цену бутылок водки уточнить у ресторана.",
    ...(metrics && fund?.records ? [metrics.total > fund.records.reduce((sum, record) => sum + record.amount, 0)
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
  const source = photos[name] || servingPhotos[name] || catalogPhoto(name);
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

const menuLabel = index => "Вариант " + (index + 1) + " · " + menuNames[index];
const programStages = () => (menus[selectedMenu] ?? menus[0])[0].slice(0, 5);

function chooseMenu(index) {
  selectedMenu = index;
  renderMenu();
  renderSeating();
  get("publish").disabled = !planDraft || publishing;
}

const programButtons = menuNames.map((name, index) => {
  const control = button("Меню " + (index + 1), () => {
    const bar = get("program-switcher").getBoundingClientRect();
    const previousSteps = [...get("serving-timeline").children];
    const visible = previousSteps.findIndex(step => {
      const rect = step.getBoundingClientRect();
      return rect.top <= bar.bottom && rect.bottom > bar.bottom;
    });
    const offset = visible === -1 ? 0 : bar.bottom - previousSteps[visible].getBoundingClientRect().top;
    chooseMenu(index);
    if (visible >= 0) {
      const rect = get("serving-timeline").children[visible].getBoundingClientRect();
      const edge = get("program-switcher").getBoundingClientRect().bottom;
      window.scrollBy({ top: rect.top + Math.min(offset, Math.max(0, rect.height - 28)) - edge, behavior: "instant" });
    }
    animateChange(get("serving-timeline"));
  }, false);
  control.setAttribute("aria-label", "Меню " + (index + 1) + " · " + name);
  return control;
});
get("program-variants").replaceChildren(...programButtons);

const comparisonButtons = menuNames.map((name, index) => {
  const control = button("Вариант " + (index + 1), () => {
    if (comparison.has(index)) comparison.delete(index);
    else comparison.add(index);
    if (comparison.size < 2) comparisonActive = false;
    filterComparison();
  }, false);
  control.setAttribute("aria-label", "Вариант " + (index + 1) + " для сравнения · " + name);
  return control;
});
get("menu-compare-options").replaceChildren(...comparisonButtons);

function filterComparison() {
  comparisonButtons.forEach((control, index) => control.setAttribute("aria-pressed", String(comparison.has(index))));
  get("menu-compare-apply").disabled = comparison.size < 2 || comparisonActive;
  get("menu-compare-clear").hidden = !comparisonActive;
  [...get("choices").children].forEach((card, index) => { card.hidden = comparisonActive && !comparison.has(index); });
}

get("menu-compare-apply").addEventListener("click", () => {
  if (comparison.size < 2) return;
  comparisonActive = true;
  filterComparison();
  get("menu-compare-clear").focus({ preventScroll: true });
});
get("menu-compare-clear").addEventListener("click", () => {
  comparisonActive = false;
  filterComparison();
  get("menu-compare-apply").focus({ preventScroll: true });
});

function renderMenu() {
  const active = document.activeElement?.getAttribute("aria-label");
  const stages = programStages();
  get("choices").replaceChildren(...menus.map(([steps], i) => {
    const card = element("article", null, "menu-choice");
    card.dataset.selected = String(i === selectedMenu);
    const choice = button(i === selectedMenu ? "Открыть подачу" : "Выбрать и открыть подачу", () => {
      chooseMenu(i);
      location.hash = "program";
      showView();
      get("program-title").focus({ preventScroll: true });
    });
    choice.setAttribute("aria-label", choice.textContent + " · вариант " + (i + 1));
    const stageRows = steps.map((_, stage) => rowsFor(i, stage));
    const beverageRows = rowsFor(i, 6);
    const estimate = orderMetrics(stageRows, beverageRows, drafts[i].fee);
    const cost = element("p", null, "menu-cost");
    cost.append(element("strong", rubles(estimate.total)),
      element("small", rubles(estimate.total / guestCount) + "/гостя"));
    const balance = budget - estimate.total;
    const balanceLabel = balance < 0 ? "Сверх бюджета " + rubles(-balance) : "Резерв " + rubles(balance);
    const course = element("dl", null, "menu-courses");
    for (const [index, label] of [[1, "Салаты"], [2, "Первое горячее"], [3, "Второе горячее"]]) {
      const names = stageRows[index].filter(row => row[1] > 0).map(row => row[0]);
      course.append(element("dt", label), element("dd", names.join(", ") || "Без заказа"));
    }
    const included = beverageRows.filter(row => row[1] > 0);
    let beverageLabel = "Отдельно от сметы";
    if (estimate.categories[1] > 0) beverageLabel = estimate.categories[2] > 0
      ? "Алкоголь и безалкогольные в смете" : "Алкоголь включён";
    else if (included.length) beverageLabel = included.map(row => row[0].replace(", графин", "")).join(", ");
    course.append(element("dt", "Напитки"), element("dd", beverageLabel));
    const badge = i === selectedMenu ? " · выбран" : "";
    card.append(element("p", "Вариант " + (i + 1) + badge, "menu-index"),
      element("h3", menuNames[i]), cost,
      element("p", balanceLabel, balance < 0 ? "warn menu-balance" : "muted menu-balance"),
      course, element("small", currency.format(estimate.weight / guestCount) + " г еды на гостя", "muted"));
    if (snapshot?.menu_authors[i]) card.append(element("small", snapshot.menu_authors[i], "muted"));
    card.append(choice);
    return card;
  }));
  filterComparison();
  programButtons.forEach((control, index) => control.setAttribute("aria-pressed", String(index === selectedMenu)));
  setText("program-selection", selectedMenu == null ? "Выберите меню, чтобы увидеть блюда и напитки по времени." : menuLabel(selectedMenu));
  renderServingTimeline();
  setText("menu-note", menuNotes[selectedMenu] ?? "");
  const plan = snapshot?.plan;
  setText("plan-status", plan?.menu != null
    ? "Утверждено организатором: вариант " + (plan.menu + 1) + ". Расчёты на странице можно менять в черновике."
    : "Меню ожидает утверждения организатором.");
  get("show-plan").hidden = plan?.menu == null;
  for (const id of ["suggested-bar", "reset-menu", "fee", "copy-menu"]) get(id).disabled = selectedMenu == null;
  const [time, title, detail] = stages[selectedStage];
  const stageRows = rowsFor(selectedMenu, selectedStage);
  if (selectedMenu == null) {
    get("stage").replaceChildren(element("p", "Выберите меню, чтобы посмотреть порции и цены."));
    get("drinks").replaceChildren(element("p", "Выберите меню, чтобы посмотреть напитки."));
  } else {
    get("stage").replaceChildren(element("h3", title), element("p", time + " · " + detail),
      ...stageRows.map((row, i) => dishRow(row, selectedStage, i)),
      element("p", "Стоимость подачи — " + rubles(costs(stageRows))));
    get("drinks").replaceChildren(...rowsFor(selectedMenu, 6).map((row, i) => dishRow(row, 6, i)));
  }
  get("fee").value = drafts[selectedMenu]?.fee ?? "";
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

function servingDrinks(stage) {
  const drinks = rowsFor(selectedMenu, 6);
  const hotDrinks = ([name]) => /чай|кофе|американо/i.test(name);
  return stage === 0 ? drinks.filter(row => !hotDrinks(row)) : stage === 4 ? drinks.filter(hotDrinks) : [];
}

function renderServingTimeline() {
  const tables = visibleTables();
  if (!tables) {
    timelineKey = "";
    get("serving-timeline").replaceChildren();
    return;
  }
  const key = JSON.stringify([selectedMenu, tables, [...(drafts[selectedMenu]?.adjustments.values() ?? [])]]);
  if (timelineKey === key) return;
  timelineKey = key;
  get("serving-timeline").replaceChildren(...programStages().map(([time, name], i) => {
    const step = element("li", null, "serving-step");
    step.id = "serving-step-" + i;
    step.append(element("p", time, "serving-time"),
      element("h3", i === 0 && selectedMenu != null
        ? "Сбор гостей · " + (tables === 1 ? "стол уже накрыт" : "столы уже накрыты") : name));
    if (selectedMenu == null) return step;
    const food = rowsFor(selectedMenu, i);
    const rows = [...food, ...servingDrinks(i)].filter(row => row[1] > 0);
    if (!rows.length) step.append(element("p", i === 4 ? "Чай и десерты по желанию." : "По выбранному меню отдельной подачи нет.", "muted"));
    for (let table = 0; table < tables && rows.length; table++) {
      const portions = tablePortions(rows, table, tables).filter(row => row[1] > 0);
      if (!portions.length) continue;
      const group = element("div", null, "serving-table");
      group.append(element("h4", tables === 1 ? "Общий стол" : "Стол " + (table + 1)));
      const list = element("ul", null, "serving-items");
      for (const [dish, quantity, , grams] of portions) {
        const item = element("li");
        const source = photos[dish] || servingPhotos[dish] || catalogPhoto(dish);
        if (source) {
          const image = element("img");
          image.src = source;
          image.alt = "";
          image.loading = "lazy";
          image.decoding = "async";
          image.width = 56;
          image.height = 56;
          image.addEventListener("error", () => image.remove(), { once: true });
          item.append(image);
        }
        const text = element("div");
        text.append(element("strong", dish), element("small", "× " + quantity + (grams ? " · " + grams + " г за порцию" : "")));
        item.append(text);
        list.append(item);
      }
      group.append(list);
      step.append(group);
    }
    const actions = element("div", null, "actions");
    const link = element("a", "Показать на столе");
    link.href = "#seating";
    link.addEventListener("click", () => selectServing(i));
    const edit = button("Порции и цены", () => {
      selectServing(i);
      const editor = get("serving-editor");
      editor.open = true;
      editor.scrollIntoView({ block: "start" });
      editor.querySelector("summary")?.focus({ preventScroll: true });
    });
    actions.append(link, edit);
    step.append(actions);
    return step;
  }));
}

function selectServing(index) {
  selectedStage = index;
  selectedZone = 1;
  renderMenu();
  renderSeating();
  animateChange(get("table-detail"));
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

const publishedTables = () => snapshot?.plan.table_count ?? 2;
const visibleTables = () => planDraft?.tables ?? previewTables;
const seatTable = index => visibleTables() === 2 && index >= 7 ? 1 : 0;
const layoutLabel = count => count === 1 ? "Один стол · 13 мест" : "Два стола · 7 и 6 мест";

function renderLayoutSummary() {
  const tableCount = visibleTables();
  get("layout-start-actions").hidden = !tableCount;
  get("start-layout-one").setAttribute("aria-pressed", String(tableCount === 1));
  get("start-layout-two").setAttribute("aria-pressed", String(tableCount === 2));
  setText("layout-start-hint", tableCount ? "Предпочтения гостей по напиткам для этой схемы." :
    "После выбора откроются меню, программа подачи и схема столов.");
  setText("menu-layout-label", tableCount ? layoutLabel(tableCount) : "");
  setText("program-menu", tableCount ? "План подачи · " + layoutLabel(tableCount) : "План подачи для всех гостей");
  for (const id of ["layout-start-summary", "menu-layout-summary"]) {
    const box = get(id);
    box.replaceChildren();
    if (!snapshot || !tableCount) continue;
    const order = planDraft?.seats ?? snapshot.plan.seats;
    const groups = new Map(snapshot.guests.map(guest => [guest.id, guest.drink_group]));
    for (const [index, [start, , end]] of seatingRows(tableCount).entries()) {
      const table = element("article");
      const counts = { strong: 0, other: 0, none: 0, unknown: 0 };
      for (const guest of order.slice(start, end)) {
        const group = groups.get(guest);
        counts[Object.hasOwn(counts, group) ? group : "unknown"]++;
      }
      table.append(element("strong", tableCount === 1 ? "Общий стол" : "Стол " + (index + 1)),
        element("p", Object.entries(counts).map(([group, count]) => drinkGroups[group] + " · " + count).join(" / ")));
      box.append(table);
    }
  }
}

function renderSeating() {
  const order = planDraft?.seats || snapshot?.plan.seats || defaultSeats;
  const tableCount = visibleTables();
  if (!tableCount) {
    get("seats").replaceChildren();
    get("seating-review").replaceChildren();
    get("table-detail").replaceChildren();
    get("guest-card").replaceChildren();
    return;
  }
  const isPreview = !planDraft && tableCount !== publishedTables();
  selectedTable = Math.min(selectedTable, tableCount - 1);
  get("seats").dataset.tables = tableCount;
  get("layout-one").setAttribute("aria-pressed", String(tableCount === 1));
  get("layout-two").setAttribute("aria-pressed", String(tableCount === 2));
  get("seating-edit").hidden = !snapshot?.admin || Boolean(planDraft);
  get("seating-approve").hidden = !planDraft;
  const guestId = order[selectedSeat];
  const guest = snapshot?.guests.find(person => person.id === guestId);
  const assignmentSet = planDraft?.assignments[selectedMenu]
    || (selectedMenu === snapshot?.plan.menu ? snapshot.plan.assignments : {});
  const serving = get("table-serving");
  serving.replaceChildren(...programStages().map(([time, title], index) => new Option(time + " · " + title, index)));
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
      selectedTable = seatTable(index);
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
  const zones = tableZones(rowsFor(selectedMenu, selectedStage), servingDrinks(selectedStage));
  const zoneLabels = ["Без алкоголя", "Блюда", "Другие напитки"];
  const splits = seatingRows(tableCount);
  const tables = splits.map(([start, middle, end], table) => {
    const room = element("section", null, "seating-table");
    const top = element("div", null, "seat-row seat-row-top");
    const bottom = element("div", null, "seat-row seat-row-bottom");
    top.append(...buttons.slice(start, middle));
    bottom.append(...buttons.slice(middle, end));
    const surface = element("div", null, "table banquet-table");
    const zoneControls = element("div", null, "table-zones");
    zones.forEach((zone, index) => {
      const rows = tablePortions(zone.rows, table, tableCount).filter(row => row[1] > 0);
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
      const source = rows.map(([name]) => photos[name] || servingPhotos[name] || catalogPhoto(name)).find(Boolean);
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
    heading.append(element("span", tableCount === 1 ? "Общий стол" : "Стол " + (table + 1)), element("small", (end - start) + " мест"));
    room.append(heading, top, surface, bottom);
    return room;
  });
  get("seats").replaceChildren(...tables);
  const tableDetail = get("table-detail");
  const zone = zones[selectedZone];
  const portions = tablePortions(zone.rows, selectedTable, tableCount).filter(row => row[1] > 0);
  const tableLabel = tableCount === 1 ? "Общий стол" : "Стол " + (selectedTable + 1);
  tableDetail.replaceChildren(element("h3", tableLabel + " · " + zone.name),
    element("p", tableCount === 1 ? "Все порции выбранной подачи на одном столе." : "Пример сервировки пропорционально числу мест.", "muted"));
  if (portions.length) {
    const list = element("ul");
    for (const [name, quantity, , grams] of portions) {
      list.append(element("li", name + " × " + quantity + (grams ? " · " + grams + " г/порция" : "")));
    }
    tableDetail.append(list);
  } else if (selectedMenu == null) {
    const link = element("a", "Выбрать меню на таймлайне");
    link.href = "#program";
    tableDetail.append(link);
  } else tableDetail.append(element("p", "Для этой зоны в текущем меню нет позиций."));
  setText("seats-status", planDraft ? "Черновик организатора. Формат применится после утверждения плана."
    : isPreview ? "Предпросмотр. Формат общего плана остался прежним."
    : snapshot?.plan.revision ? "Утверждённый формат. Выберите место для просмотра."
    : "Предварительная схема. Выберите место, чтобы открыть карточку.");
  const card = get("guest-card");
  card.replaceChildren(element("h3", "Место " + (selectedSeat + 1) + " · " + (guest?.profile?.[0] || nameOf(guestId))));
  const [start, middle, end] = splits.find(([first, , last]) => selectedSeat >= first && selectedSeat < last);
  const opposite = selectedSeat < middle ? middle + selectedSeat - start : start + selectedSeat - middle;
  if (opposite < end) card.append(element("p", "Напротив · " + nameOf(order[opposite]), "muted"));
  if (guest) card.append(element("p", drinkGroups[groupOf(guestId)], "muted"));
  if (guest?.profile) {
    const list = element("dl");
    ["Салаты", "Горячее", "Напитки", "Ограничения"].forEach((label, i) => {
      list.append(element("dt", label), element("dd", guest.profile[i + 3] || "—"));
    });
    card.append(list);
  }
  const ownButton = snapshot && !planDraft && !isPreview ? button("Предложить это место", () => {
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
      selectedTable = seatTable(index);
      renderLayoutSummary();
      renderSeating();
    });
    label.append(swap);
    card.append(label);
  }
  const allocation = get("allocation");
  allocation.hidden = selectedMenu == null;
  if (selectedMenu == null) {
    allocation.replaceChildren();
    renderSeatingReview(order, tableCount);
    return;
  }
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
  renderSeatingReview(order, tableCount);
}

function renderSeatingReview(order, tableCount) {
  const panel = get("seating-review");
  panel.replaceChildren();
  panel.hidden = !snapshot?.admin;
  if (panel.hidden) return;
  const requests = snapshot.wishes;
  const { checks, adjacent, strong } = seatingReview(order, tableCount, requests, snapshot.guests);
  panel.append(element("h3", "Как учтены пожелания"),
    element("p", "Учтено " + checks.filter(check => check.met).length + " из " + checks.length + " пожеланий о месте и соседе."),
    element("p", "Рядом с другим гостем, выбравшим крепкие напитки · " + adjacent + " из " + strong + "."));
  const list = element("ul", null, "seating-checks");
  for (const { wish, type, met } of checks) {
    const label = type === "seat" ? "место " + wish.seat
      : (type === "apart" ? "отдельно от гостя " : "рядом с гостем ") + nameOf(wish.neighbor);
    list.append(element("li", nameOf(wish.guest_id) + " · " + label + " · " + (met ? "учтено" : "пока не учтено"),
      met ? "" : "warn"));
  }
  panel.append(list);
  const next = suggestSeats(order, tableCount, requests, snapshot.guests);
  if (next.some((id, i) => id !== order[i])) {
    panel.append(button("Примерить рассадку с учётом пожеланий", () => {
      if (!planDraft) editPlan();
      planDraft.seats = next;
      renderLayoutSummary();
      renderSeating();
      get("seats").scrollIntoView({ block: "start" });
    }));
  }
}

function loadWish() {
  const current = snapshot.wishes.find(row => row.guest_id === snapshot.member);
  wishRevision = current?.revision || 0;
  wishDirty = false;
  setOptions(fields.seat, defaultSeats.map((_, i) => [i + 1, "Место " + (i + 1)]), current?.seat);
  setOptions(fields.neighbor, snapshot.guests.filter(row => row.id !== snapshot.member).map(row => [row.id, row.name]), current?.neighbor);
  setOptions(fields.variant, menuNames.map((name, i) => [i, (i + 1) + " · " + name]), current?.menu);
  fields.note.value = current?.note || "";
  wishFood = {};
  for (const [slot, name] of [["salad", current?.salad], ["main", current?.hot]]) {
    if (name) wishFood[slot] = { ...current.details?.food?.[slot], name };
  }
  const previousItems = current?.details?.items ?? [];
  wishDrinks = previousItems.filter(item => item.kind === "drink");
  wishLegacyDishes = previousItems.filter(item => item.kind === "dish");
  renderWishChoices();
}

const wishSlots = {
  salad: "Выбрать салат",
  main: "Выбрать основное блюдо",
  drink: "Добавить напиток"
};
const wishItemLabel = item => item.name + (Number.isFinite(item.price) ? " · " + rubles(item.price) : "");

function renderWishChoices() {
  for (const slot of ["salad", "main"]) {
    const choice = wishFood[slot];
    setText("wish-" + slot, choice ? wishItemLabel(choice) : "Пока не выбрано");
    setText("pick-wish-" + slot, choice ? (slot === "main" ? "Изменить блюдо" : "Изменить салат") : wishSlots[slot]);
    get("clear-wish-" + slot).hidden = !choice;
  }
  const drinks = get("wish-drinks");
  drinks.replaceChildren(...wishDrinks.map((item, index) => {
    const line = element("li");
    const info = element("span", wishItemLabel(item));
    if (item.category) info.append(element("small", item.category, "muted"));
    const remove = button("Убрать", () => {
      wishDrinks.splice(index, 1);
      wishDirty = true;
      renderWishChoices();
      get("pick-wish-drink").focus({ preventScroll: true });
    });
    remove.setAttribute("aria-label", "Убрать " + wishItemLabel(item));
    line.append(info, remove);
    return line;
  }));
  if (!wishDrinks.length) drinks.append(element("li", "Пока не выбраны", "muted"));
  get("wish-legacy-items").hidden = !wishLegacyDishes.length;
  setText("wish-legacy-items", wishLegacyDishes.length
    ? "Ранее добавленные блюда · " + wishLegacyDishes.map(item => item.name).join(", ")
    : "");
}

const wishSearchText = text => text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
const sameWishItem = (a, b) => a.name === b.name && a.category === b.category && a.price === b.price;
const coldCatalogGroups = new Set(["Лимонады и б/а коктейли", "Б/а напитки"]);

function renderWishPicker() {
  const category = get("wish-picker-category").value;
  const group = pickerGroups.find(group => group.category === category);
  const results = get("wish-picker-results");
  if (!group) {
    results.replaceChildren();
    setText("wish-picker-status", pickerGroups.length ? "Сначала выберите категорию." : "");
    return;
  }
  const query = wishSearchText(get("wish-picker-search").value);
  const available = group.items.filter(([name]) => wishSearchText(name).includes(query));
  const maxReached = pickerSlot === "drink" && wishLegacyDishes.length + wishDrinks.length >= 15;
  setText("wish-picker-status", maxReached ? "Достигнут лимит из 15 дополнительных позиций." :
    available.length ? "" : "По этому запросу в категории ничего нет.");
  results.replaceChildren(...available.map(([name, price]) => {
    const item = { name, category, price };
    const isDrink = pickerSlot === "drink";
    const selected = isDrink ? wishDrinks.some(drink => sameWishItem(drink, item)) :
      wishFood[pickerSlot] && sameWishItem(wishFood[pickerSlot], item);
    const control = button(null, () => {
      if (isDrink) {
        const legacyIndex = wishDrinks.findIndex(drink => drink.name === name && !drink.category);
        if (legacyIndex !== -1) wishDrinks.splice(legacyIndex, 1);
        wishDrinks.push({ kind: "drink", ...item });
      } else wishFood[pickerSlot] = item;
      wishDirty = true;
      renderWishChoices();
      if (isDrink) {
        renderWishPicker();
        setText("wish-picker-status", "Добавлено · " + name);
        get("wish-picker-category").focus({ preventScroll: true });
      } else get("wish-picker").close();
    });
    control.disabled = Boolean(selected || maxReached);
    control.append(element("strong", name), element("small", rubles(price) + (selected ? " · выбрано" : "")));
    return control;
  }));
}

async function populateWishPicker() {
  const request = ++pickerRequest;
  const select = get("wish-picker-category");
  select.disabled = true;
  get("wish-picker-search").disabled = true;
  get("wish-picker-results").replaceChildren();
  setText("wish-picker-status", "Загружаем каталог…");
  try {
    const groups = await loadCatalogGroups();
    if (request !== pickerRequest || !get("wish-picker").open) return;
    pickerGroups = wishCatalog(groups, pickerSlot);
    setOptions(select, pickerGroups.map(({ category }) => [
      category, coldCatalogGroups.has(category) ? "Холодные · " + category : category
    ]), pickerGroups.length === 1 ? pickerGroups[0].category : wishFood[pickerSlot]?.category, "Выберите категорию");
    select.disabled = false;
    get("wish-picker-search").disabled = false;
    renderWishPicker();
    (pickerGroups.length === 1 ? get("wish-picker-search") : select).focus({ preventScroll: true });
  } catch {
    if (request !== pickerRequest || !get("wish-picker").open) return;
    setText("wish-picker-status", "Каталог не загрузился.");
    get("wish-picker-results").replaceChildren(button("Загрузить снова", populateWishPicker));
  }
}

for (const [slot, label] of Object.entries(wishSlots)) {
  get("pick-wish-" + slot).addEventListener("click", () => {
    if (!snapshot) return;
    pickerSlot = slot;
    pickerGroups = [];
    setText("wish-picker-title", label);
    get("wish-picker-category-label").hidden = slot === "salad";
    get("wish-picker-search").value = "";
    get("wish-picker").showModal();
    void populateWishPicker();
  });
  if (slot === "drink") continue;
  get("clear-wish-" + slot).addEventListener("click", () => {
    delete wishFood[slot];
    wishDirty = true;
    renderWishChoices();
    get("pick-wish-" + slot).focus({ preventScroll: true });
  });
}
get("wish-picker-category").addEventListener("change", () => {
  get("wish-picker-search").value = "";
  renderWishPicker();
});
get("wish-picker-search").addEventListener("input", renderWishPicker);
get("wish-picker-close").addEventListener("click", () => get("wish-picker").close());


function describeWish(wish) {
  return [
    wish.seat == null ? "" : "Место " + wish.seat,
    wish.neighbor == null ? "" : "Сосед · " + nameOf(wish.neighbor),
    wish.menu == null ? "" : "Вариант меню " + (wish.menu + 1),
    wish.details?.layout ? (wish.details.layout === 1 ? "Для одного стола" : "Для двух столов") : "",
    wish.salad, wish.hot, ...(wish.details?.items || []).map(item =>
      (item.kind === "drink" ? "Напиток · " : "Блюдо · ") + wishItemLabel(item) + (item.category ? " · " + item.category : "")),
    wish.note
  ].filter(Boolean);
}

function showView(scroll = true) {
  const fragment = location.hash.slice(1);
  const raw = fragment === "history" ? "wishes" : fragment;
  const servingAnchor = /^serving-step-[0-4]$/.test(raw);
  const known = ["overview", "menu", "program", "beverage-editor", "seating", "wishes", "organizer", "catalog"].includes(raw)
    && (raw !== "organizer" || snapshot?.admin);
  const target = servingAnchor ? "program" : known ? raw : "overview";
  const panel = get(target);
  const view = target === "beverage-editor" ? "menu" : panel.dataset.view;
  const needsLayout = !visibleTables() && (view === "menu" || view === "seating");
  const layoutStart = get("layout-start");
  layoutStart.hidden = !snapshot || (!needsLayout && view !== "overview");
  if (target === "beverage-editor") panel.open = true;
  document.querySelectorAll("[data-view]").forEach(section => {
    section.classList.toggle("view-off", needsLayout || section.dataset.view !== view);
  });
  document.querySelectorAll("[data-nav]").forEach(link => {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  if (snapshot && view === "catalog") void setCatalogAccess(true);
  if (snapshot && scroll) {
    if (needsLayout) layoutStart.scrollIntoView({ block: "start" });
    else if (servingAnchor) (get(raw) || panel).scrollIntoView({ block: "start" });
    else if (raw && target !== "overview") panel.scrollIntoView({ block: "start" });
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
  get("edit-plan").disabled = Boolean(planDraft);
  get("discard-plan").disabled = !planDraft || publishing;
  get("publish").disabled = !planDraft || publishing || selectedMenu == null;
  if (!member) {
    void setCatalogAccess(false);
    get("layout-start").hidden = true;
    get("review").replaceChildren();
    get("votes").replaceChildren();
    get("payments").replaceChildren();
    get("drink-analytics").replaceChildren();
    wish.reset();
    return;
  }
  if (entering) {
    showView();
    if (!location.hash) get("layout-start-title").focus({ preventScroll: true });
  }

  if (!wishDirty) loadWish();
  renderOverview();
  const wishes = snapshot.admin ? snapshot.wishes : [];
  get("votes").replaceChildren(...(snapshot.admin ? menuNames.map((name, i) =>
    element("p", "Вариант " + (i + 1) + " · " + name + " — " + wishes.filter(item => item.menu === i).length)) : []));
  get("review").replaceChildren(...wishes.map(item => {
    const info = describeWish(item).join(" · ");
    return element("li", nameOf(item.guest_id) + (info ? " — " + info : " — без пожеланий"));
  }));
}

function usePlan(plan) {
  selectedMenu = plan.menu;
  selectedStage = 0;
  if (plan.menu == null) return;
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
  if (!focusInSeating || !previous || previous.plan.revision !== snapshot.plan.revision) renderSeating();
}

function switchUser(session) {
  const next = session?.user?.id || null;
  if (next === userId) return;
  userId = next;
  wishChallenge?.close();
  wishChallenge = null;
  syncSequence++;
  snapshot = null;
  planDraft = null;
  previewTables = null;
  selectedMenu = null;
  comparison.clear();
  comparisonActive = false;
  wishFood = {};
  wishDrinks = [];
  wishLegacyDishes = [];
  pickerRequest++;
  if (get("wish-picker").open) get("wish-picker").close();
  timelineKey = "";
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
wish.addEventListener("submit", async event => {
  event.preventDefault();
  if (!snapshot || wishChallenge?.open || openingWishChallenge) return;
  const owner = userId;
  const participant = snapshot.guests.find(guest => guest.id === snapshot.member)?.profile?.[0]
    || nameOf(snapshot.member);
  const submit = get("save-wish");
  const number = field => field.value === "" ? null : Number(field.value);
  const parameters = {
    expected_revision: wishRevision, wanted_seat: number(fields.seat), wanted_neighbor: number(fields.neighbor),
    wanted_menu: number(fields.variant), wanted_salad: wishFood.salad?.name ?? null,
    wanted_hot: wishFood.main?.name ?? null, wanted_note: fields.note.value.trim(),
    wanted_details: structuredClone({ food: wishFood, items: [...wishLegacyDishes, ...wishDrinks] })
  };
  openingWishChallenge = true;
  submit.disabled = true;
  try {
    const { openGrinch } = await import("./grinch.mjs?v=3");
    if (owner !== userId || !snapshot) return;
    wishDirty = true;
    const challenge = openGrinch({
      participant,
      onBack: () => { location.hash = "menu"; showView(); },
      loadRanking: async () => {
        if (owner !== userId) throw new Error("Сеанс завершён.");
        const { data, error } = await client.rpc("banquet_grinch_ranking");
        if (error) throw error;
        return data;
      },
      recordResult: async ({ centiseconds, friendly, misses }) => {
        if (owner !== userId) throw new Error("Сеанс завершён.");
        const { data, error } = await client.rpc("banquet_grinch_record", {
          game_centiseconds: centiseconds, game_friendly: friendly, game_misses: misses
        });
        if (error) throw error;
        return data;
      },
      onVictory: async () => {
        if (owner !== userId || !snapshot) {
          throw Object.assign(new Error("Сеанс завершён. Войдите снова."), { retryable: false });
        }
        const { data, error } = await client.rpc("banquet_save_wish", parameters);
        if (owner !== userId) return;
        if (error?.code === "40001") {
          await sync();
          wishRevision = snapshot?.wishes.find(row => row.guest_id === snapshot.member)?.revision || 0;
          throw Object.assign(new Error("Пожелания изменились на другом устройстве. Вернитесь в анкету и проверьте их."), { retryable: false });
        }
        if (error) throw new Error("Не удалось отправить пожелания. Попробуйте снова.");
        wishRevision = data;
        wishDirty = false;
        setText("wish-status", "Пожелания отправлены организатору.");
        void sync();
      }
    });
    wishChallenge = challenge;
    challenge.addEventListener("close", () => {
      if (wishChallenge === challenge) wishChallenge = null;
    }, { once: true });
  } catch {
    setText("wish-status", "Испытание не загрузилось. Попробуйте снова.");
  } finally {
    openingWishChallenge = false;
    submit.disabled = false;
  }
});

function editPlan() {
  if (!snapshot?.admin) return;
  if (planDraft) return;
  if (!visibleTables()) {
    location.hash = "seating";
    showView();
    get("layout-start-title").focus({ preventScroll: true });
    return;
  }
  const plan = snapshot.plan;
  planDraft = { revision: plan.revision, seats: [...plan.seats], tables: visibleTables(), assignments: {} };
  if (plan.menu != null) planDraft.assignments[plan.menu] = structuredClone(plan.assignments);
  renderOnline();
  renderMenu();
  renderSeating();
  setText("publish-status", "Черновик открыт. Места и порции можно изменить выше.");
}
get("edit-plan").addEventListener("click", editPlan);
get("edit-seating").addEventListener("click", () => {
  editPlan();
  get("layout-" + (visibleTables() === 1 ? "one" : "two")).focus({ preventScroll: true });
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
  if (!snapshot?.admin || !planDraft || publishing || selectedMenu == null) return;
  const owner = userId;
  const draft = drafts[selectedMenu];
  if (activeTotal() > budget && !window.confirm("Заказ превышает бюджет. Утвердить план с превышением?")) return;
  publishing = true;
  renderOnline();
  const { data, error } = await client.rpc("banquet_publish", {
    expected_revision: planDraft.revision, approved_menu: selectedMenu, approved_seats: planDraft.seats,
    approved_adjustments: [...draft.adjustments.values()], approved_assignments: planDraft.assignments[selectedMenu] || {},
    approved_fee: draft.fee, approved_tables: planDraft.tables
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
  if (selectedMenu == null) return;
  const recommended = menus[3][1];
  rowsFor(selectedMenu, 6).forEach((row, i) => {
    const fromMenu = recommended.find(drink => drink[0] === row[0]);
    if (fromMenu && fromMenu[1] > row[1]) drafts[selectedMenu].adjustments.set("6:" + i, [6, i, fromMenu[1], row[2]]);
  });
  renderMenu();
  renderSeating();
});
get("reset-menu").addEventListener("click", () => {
  if (selectedMenu == null) return;
  drafts[selectedMenu] = blankDraft();
  renderMenu();
  renderSeating();
});
get("fee").addEventListener("change", event => {
  if (selectedMenu == null) return;
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
  if (selectedMenu == null) return;
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
function chooseLayout(tableCount) {
  previewTables = tableCount;
  if (planDraft) planDraft.tables = tableCount;
  selectedTable = seatTable(selectedSeat);
  renderOverview();
  renderSeating();
  renderServingTimeline();
}

for (const [id, tableCount] of [["layout-one", 1], ["layout-two", 2]]) {
  get(id).addEventListener("click", () => {
    chooseLayout(tableCount);
    animateChange(get("seats"));
  });
}
for (const [id, tableCount] of [["start-layout-one", 1], ["start-layout-two", 2]]) {
  get(id).addEventListener("click", () => {
    chooseLayout(tableCount);
    const target = location.hash.slice(1);
    showView(Boolean(target && target !== "overview"));
    const destination = { menu: "menu-title", program: "program-title", seating: "seats-title", "beverage-editor": "beverage-editor" }[target];
    if (destination) get(destination).focus({ preventScroll: true });
  });
}
get("table-serving").addEventListener("change", event => selectServing(Number(event.currentTarget.value)));
get("my-seat").addEventListener("click", () => {
  if (!snapshot) return;
  const order = planDraft?.seats || snapshot.plan.seats;
  const index = order.indexOf(snapshot.member);
  if (index < 0) return;
  selectedSeat = index;
  selectedTable = seatTable(index);
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

startOnline();
