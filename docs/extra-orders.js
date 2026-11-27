const format = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB",
  minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = cents => format.format(cents / 100);
const normalized = value => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
const byId = id => document.getElementById(id);

function element(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text ?? "";
  return el;
}

function button(label, action) {
  const control = element("button", label);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

export function installExtraOrders({ session, refresh, loadCatalog }) {
  const form = byId("extra-order-form");
  const choices = byId("extra-order-choices");
  const catalog = byId("extra-order-catalog");
  const search = byId("extra-order-search");
  const catalogStatus = byId("extra-order-catalog-status");
  const name = byId("extra-order-name");
  const quantity = byId("extra-order-quantity");
  const price = byId("extra-order-price");
  const volume = byId("extra-order-volume");
  const status = byId("extra-order-status");
  const add = byId("extra-order-add");
  let groups;
  let selected;
  let pending;
  let busy = false;

  function setBusy(value) {
    busy = value;
    for (const field of [name, quantity, price, search, add]) field.disabled = value;
  }

  function renderVolume() {
    volume.hidden = !selected?.volume;
    volume.textContent = selected?.volume ? "Объём порции · " + selected.volume + " мл" : "";
  }

  function renderChoices() {
    if (!groups || !session()) return;
    const query = normalized(search.value);
    choices.replaceChildren();
    if (!query) {
      catalogStatus.textContent = "Введите название блюда или напитка.";
      return;
    }
    const matches = groups.flatMap(({ category, items }) => items.filter(([title]) =>
      normalized(title).includes(query)).map(([title, cost, , volume]) => ({ title, cost, volume, category })));
    catalogStatus.textContent = matches.length === 0 ? "Совпадений нет. Название можно ввести вручную." :
      matches.length > 12 ? "Первые 12 совпадений. Уточните название для поиска." : "";
    for (const item of matches.slice(0, 12)) {
      const choose = button("", () => {
        if (busy) return;
        selected = item;
        name.value = item.title;
        price.value = item.cost;
        renderVolume();
        catalog.open = false;
        quantity.focus({ preventScroll: true });
      });
      choose.append(element("strong", item.title),
        element("small", item.category + (item.volume ? " · " + item.volume + " мл" : "") + " · " + money(item.cost * 100)));
      choices.append(choose);
    }
  }

  async function openCatalog() {
    catalogStatus.textContent = "Загружаем каталог…";
    try {
      groups = await loadCatalog();
      renderChoices();
    } catch {
      if (!session()) return;
      catalogStatus.textContent = "Каталог не загрузился. Название можно ввести вручную.";
      choices.replaceChildren(button("Повторить загрузку", openCatalog));
    }
  }

  catalog.addEventListener("toggle", () => { if (catalog.open && session()) void openCatalog(); });
  search.addEventListener("input", renderChoices);
  name.addEventListener("input", () => {
    if (!selected || name.value.trim() === selected.title) return;
    if (Number(price.value) === selected.cost) price.value = "";
    selected = null;
    renderVolume();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const current = session();
    if (!current || busy) return;
    const title = name.value.trim();
    if (!title) {
      status.textContent = "Укажите название блюда или напитка.";
      name.focus();
      return;
    }
    const fields = {
      order_name: title,
      order_quantity: Number(quantity.value),
      order_price_cents: price.value === "" ? null : Math.round(Number(price.value) * 100),
      order_volume_ml: selected?.title === title ? selected.volume ?? null : null
    };
    const key = JSON.stringify(fields);
    if (pending?.key !== key) pending = { key, id: crypto.randomUUID() };
    setBusy(true);
    status.textContent = "Записываем дозаказ…";
    try {
      const { error } = await current.client.rpc("banquet_add_extra_order", { order_id: pending.id, ...fields });
      if (session()?.user !== current.user) return;
      if (error) throw error;
      pending = null;
      form.reset();
      selected = null;
      catalog.open = false;
      renderVolume();
      status.textContent = "Дозаказ записан.";
      await refresh();
    } catch {
      if (session()?.user === current.user) status.textContent = "Запись пока не подтверждена. Попробуйте ещё раз.";
    } finally {
      if (session()?.user === current.user) setBusy(false);
    }
  });

  async function remove(order) {
    const current = session();
    if (!current || busy) return;
    setBusy(true);
    try {
      const { error } = await current.client.rpc("banquet_remove_extra_order", { order_id: order.id });
      if (session()?.user !== current.user) return;
      if (error) throw error;
      status.textContent = "Дозаказ убран.";
      await refresh();
    } catch {
      if (session()?.user === current.user) status.textContent = "Не удалось убрать запись. Попробуйте ещё раз.";
    } finally {
      if (session()?.user === current.user) setBusy(false);
    }
  }

  function list(container, rows, canRemove) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(element("p", "Дозаказов пока нет."));
      return;
    }
    const items = element("ul");
    items.className = "extra-order-list";
    for (const row of rows) {
      const line = element("li");
      const text = element("span");
      text.append(element("strong", row.name), element("small",
        (row.volume_ml ? row.volume_ml + " мл · " : "") + "Количество: " + row.quantity +
          (row.price_cents == null ? " · цена не указана" : " · " + money(row.price_cents * row.quantity))));
      line.append(text);
      if (canRemove) {
        const control = button("Убрать", () => void remove(row));
        control.setAttribute("aria-label", "Убрать дозаказ " + row.name);
        line.append(control);
      }
      items.append(line);
    }
    const subtotal = rows.reduce((sum, row) => sum + (row.price_cents ?? 0) * row.quantity, 0);
    container.append(items);
    if (rows.some(row => row.price_cents != null)) container.append(element("p",
      (rows.some(row => row.price_cents == null) ? "Сумма по известным ценам · " : "Итого · ") + money(subtotal)));
  }

  function render({ member, admin, extra_orders: rows = [] }, nameOf) {
    list(byId("my-extra-orders"), rows.filter(row => row.guest_id === member), true);
    const all = byId("all-extra-orders");
    all.hidden = !admin;
    const participants = byId("extra-order-participants");
    participants.replaceChildren();
    if (!admin) return;
    for (const id of new Set(rows.map(row => row.guest_id))) {
      const group = element("div");
      group.append(element("h4", nameOf(id)));
      list(group, rows.filter(row => row.guest_id === id), false);
      participants.append(group);
    }
    if (!rows.length) participants.append(element("p", "У участников пока нет дозаказов."));
  }

  function reset() {
    form.reset();
    catalog.open = false;
    selected = null;
    pending = null;
    setBusy(false);
    status.textContent = "";
    catalogStatus.textContent = "";
    choices.replaceChildren();
    renderVolume();
    byId("my-extra-orders").replaceChildren();
    byId("extra-order-participants").replaceChildren();
    byId("all-extra-orders").hidden = true;
  }

  return { render, reset };
}
