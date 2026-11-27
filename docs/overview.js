const nonAlcohol = /вода|сок|лимонад|чай|кофе|морс|б\/а|безалкоголь/i;

export const drinkPreferences = {
  vodka: "Водка", beer: "Пиво", beer_optional: "Пиво по желанию", wine: "Вино или игристое", cocktail: "Коктейли",
  light: "Лёгкий алкоголь, выбор предварительный", social: "Возможна одна рюмка",
  none: "Без алкоголя", unknown: "Данных пока нет"
};

export function orderMetrics(stages, drinks, fee) {
  const cost = rows => rows.reduce((sum, [, count, price]) => sum + count * price, 0);
  const food = stages.flat();
  const nonAlcoholic = drinks.filter(([name]) => nonAlcohol.test(name));
  const categories = [cost(food), cost(drinks) - cost(nonAlcoholic), cost(nonAlcoholic), fee];
  const weights = stages.map(rows => rows.reduce((sum, [, count, , grams]) => sum + count * (grams || 0), 0));
  return {
    categories, weights, total: categories.reduce((a, b) => a + b, 0),
    weight: weights.reduce((a, b) => a + b, 0),
    missingWeights: food.filter(([, count, , grams]) => count > 0 && !grams).length
  };
}

export function tablePortions(rows, table, tableCount = 2) {
  if (tableCount === 1) return rows;
  return rows.map(([name, count, ...rest]) => {
    const first = Math.round(count * 7 / 13);
    return [name, table === 0 ? first : count - first, ...rest];
  });
}
