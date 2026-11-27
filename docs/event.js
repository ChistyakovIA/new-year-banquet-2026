export const start = new Date("2026-12-25T18:00:00+04:00");
export const end = new Date("2026-12-26T00:00:00+04:00");

function eventTime(text) {
  const hour = Number(text.split(":")[0]);
  const day = hour < 18 ? "26" : "25";
  return new Date("2026-12-" + day + "T" + text + ":00+04:00").getTime();
}

export function programStatus(stages, now) {
  const phases = stages.map(([time]) => {
    const [from, to] = time.split("–");
    if (now >= eventTime(to)) return "done";
    return now >= eventTime(from) ? "live" : "upcoming";
  });
  const live = phases.indexOf("live");
  const next = phases.indexOf("upcoming");
  if (live >= 0) return { phases, note: "Сейчас · " + stages[live][1], next };
  if (next < 0) return { phases, note: "Вечер завершён", next };
  if (now >= start.getTime()) return { phases, note: "Далее в " + stages[next][0].split("–")[0] + " · " + stages[next][1], next };
  const minutes = Math.ceil((start.getTime() - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  const display = days ? days + " д " + hours + " ч" : hours ? hours + " ч " + remainder + " мин" : remainder + " мин";
  return { phases, note: "До встречи · " + display, next };
}

export function googleCalendarUrl() {
  const stamp = date => date.toISOString().replace(/[-:]/g, "").replace(".000", "");
  const url = new URL("https://calendar.google.com/calendar/render");
  url.search = new URLSearchParams({
    action: "TEMPLATE", text: "Новогодний вечер",
    dates: stamp(start) + "/" + stamp(end), stz: "Europe/Saratov", etz: "Europe/Saratov",
    location: "Моя узбечка, Саратов, Соколовая, 10/16",
    details: "Встреча гостей в 18:00 по Саратову.\nhttps://chistyakovia.github.io/new-year-banquet-2026/"
  });
  return url.href;
}

export function calendarHref(platform) {
  return /Android/i.test(platform) ? googleCalendarUrl() : "banquet.ics";
}

export function animateChange(element) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !element.animate) return;
  element.getAnimations().forEach(animation => animation.cancel());
  element.animate([{ opacity: .55, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], {
    duration: 180, easing: "ease-out"
  });
}

export const drinkGroups = {
  strong: "Крепкие напитки",
  other: "Другие напитки / без крепких",
  unknown: "Уточняется"
};

export function tableZones(serving, drinks) {
  const booked = drinks.filter(row => row[1] > 0);
  const nonAlcohol = /вода|сок|лимонад|чай|кофе|морс|б\/а|безалкоголь/i;
  return [
    { name: "Безалкогольные напитки", rows: booked.filter(row => nonAlcohol.test(row[0])) },
    { name: "Блюда этой подачи", rows: serving.filter(row => row[1] > 0) },
    { name: "Остальные напитки", rows: booked.filter(row => !nonAlcohol.test(row[0])) }
  ];
}
