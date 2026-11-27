const imageOrigin = "https://16a9564f-f8ec-42ba-a998-3027aa809e50.selstorage.ru";
const prices = new Intl.NumberFormat("ru-RU");
const pageSize = 24;
const element = id => document.getElementById(id);
const searchText = value => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
const photoByName = new Map();
let groups;
let loading;
let connected = false;
let visibleLimit = pageSize;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function photoUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === imageOrigin ? url.href : null;
  } catch {
    return null;
  }
}

export function catalogPhoto(name) {
  return photoByName.get(searchText(name)) || null;
}

const wishCategories = {
  salad: ["Салаты"],
  main: ["Горячее", "Плов", "Мангал", "Супы", "Тесто", "Фестиваль самсы"],
  drink: ["Алкогольные коктейли", "Крепкий алкоголь", "Пиво", "Домашние настойки", "Вино", "Лимонады и б/а коктейли", "Б/а напитки"]
};

export function wishCatalog(groups, slot) {
  const categories = wishCategories[slot] ?? [];
  return categories.flatMap(category => {
    const group = groups.find(item => item.category === category);
    if (!group) return [];
    if (category !== "Лимонады и б/а коктейли") return [group];
    return [{ ...group, items: group.items.filter(([name]) => !/^глинтвейн/i.test(name)) }];
  });
}

function openPhoto(name, price, url) {
  const dialog = element("catalog-photo");
  const image = element("photo-image");
  element("photo-title").textContent = name;
  element("photo-price").textContent = prices.format(price) + " ₽";
  image.alt = name;
  image.src = url;
  dialog.showModal();
}

function card([name, price, source], category) {
  const article = node("article", null, "catalog-card");
  const info = node("div", null, "catalog-info");
  const url = photoUrl(source);
  const placeholder = () => node("span", "Фото отсутствует", "catalog-placeholder");
  if (url) {
    const button = node("button", null, "catalog-media");
    const image = node("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = "";
    button.type = "button";
    button.setAttribute("aria-label", "Увеличить фото: " + name);
    button.addEventListener("click", () => openPhoto(name, price, url));
    image.addEventListener("error", () => button.replaceWith(placeholder()), { once: true });
    image.src = url;
    button.append(image);
    article.append(button);
  } else article.append(placeholder());
  info.append(node("p", name));
  if (category) info.append(node("small", category, "muted"));
  info.append(node("strong", prices.format(price) + " ₽"));
  article.append(info);
  return article;
}

function render() {
  if (!connected || !groups) return;
  const query = searchText(element("catalog-search").value);
  const category = element("catalog-category").value;
  const order = element("catalog-sort").value;
  let visible = groups.filter(group => !category || group.category === category);
  const sortAll = Boolean(order && !category);
  if (sortAll) visible = [{
    category: "Все категории",
    items: visible.flatMap(group => group.items.map(item => [...item, group.category]))
  }];
  let count = 0;
  let displayed = 0;
  const results = [];
  for (const group of visible) {
    const filtered = group.items.filter(([name]) => !query || searchText(name).includes(query));
    if (!filtered.length) continue;
    if (order) filtered.sort((a,b) => order === "asc" ? a[1] - b[1] : b[1] - a[1]);
    count += filtered.length;
    const page = filtered.slice(0, Math.max(0, visibleLimit - displayed));
    if (!page.length) continue;
    displayed += page.length;
    const section = node("section", null, "catalog-group");
    const grid = node("div", null, "catalog-grid");
    grid.append(...page.map(item => card(item, sortAll ? item[3] : null)));
    section.append(node("h3", group.category), grid);
    results.push(section);
  }
  if (displayed < count) {
    const more = node("button", "Показать ещё " + Math.min(pageSize, count - displayed), "catalog-more");
    more.type = "button";
    more.addEventListener("click", () => {
      const firstNewCard = displayed;
      visibleLimit += pageSize;
      render();
      const target = element("catalog-results").querySelectorAll(".catalog-card")[firstNewCard];
      target?.setAttribute("tabindex", "-1");
      target?.focus();
    });
    results.push(more);
  }
  element("catalog-status").textContent = count ? "Показано " + displayed + " из " + count : "По этому запросу ничего не найдено.";
  element("catalog-results").replaceChildren(...results);
}

export function loadCatalogGroups() {
  if (groups) return Promise.resolve(groups);
  if (!loading) {
    loading = (async () => {
      const response = await fetch(new URL("./catalog-data.json", import.meta.url), {signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw Error("Catalog request failed");
      const data = await response.json();
      if (!Array.isArray(data.groups) || data.groups.length === 0) throw Error("Catalog data is incomplete");
      groups = data.groups;
      for (const group of groups) for (const [name,,src] of group.items) {
        const url = photoUrl(src);
        if (url && !photoByName.has(searchText(name))) photoByName.set(searchText(name),url);
      }
      return groups;
    })().finally(() => { loading = null; });
  }
  return loading;
}

async function reload() {
  element("catalog-retry").hidden = true;
  element("catalog-status").textContent = "Загружаем каталог…";
  try {
    const result = await loadCatalogGroups();
    if (!connected) return false;
    element("catalog-category").replaceChildren(new Option("Все категории", ""),
      ...result.map(group => new Option(group.category, group.category)));
    render();
    return true;
  } catch {
    if (connected) {
      element("catalog-status").textContent = "Каталог не загрузился. Попробуйте ещё раз.";
      element("catalog-retry").hidden = false;
    }
    return false;
  }
}

export function setCatalogAccess(value) {
  if (connected === value) return Promise.resolve(false);
  connected = value;
  if (!connected) {
    visibleLimit = pageSize;
    element("catalog-photo").close();
    element("catalog-results").replaceChildren();
    element("catalog-search").value = "";
    element("catalog-category").value = "";
    element("catalog-sort").value = "";
    return Promise.resolve(false);
  }
  return reload();
}

function restart() { visibleLimit = pageSize; render(); }
element("catalog-search").addEventListener("input", restart);
element("catalog-category").addEventListener("change", restart);
element("catalog-sort").addEventListener("change", restart);
element("catalog-retry").addEventListener("click", () => void reload());
element("photo-close").addEventListener("click", () => element("catalog-photo").close());
element("catalog-photo").addEventListener("close", () => element("photo-image").removeAttribute("src"));
