export function seatingRows(count) {
  return count === 1 ? [[0, 7, 13]] : [[0, 4, 7], [7, 10, 13]];
}

export function seatingReview(order, count, wishes, guests) {
  const rows = seatingRows(count).flatMap(([start, middle, end]) => [[start, middle], [middle, end]]);
  const sameSide = (a, b) => rows.some(([start, end]) => a >= start && b >= start && a < end && b < end);
  const checks = wishes.flatMap(wish => {
    if (wish.details?.layout && wish.details.layout !== count) return [];
    const seat = order.indexOf(wish.guest_id);
    const neighbor = order.indexOf(wish.neighbor);
    return [
      ...(wish.seat == null ? [] : [{ wish, type: "seat", met: seat === wish.seat - 1 }]),
      ...(wish.neighbor == null ? [] : [{ wish, type: wish.apart ? "apart" : "neighbor",
        met: (Math.abs(seat - neighbor) === 1 && sameSide(seat, neighbor)) !== Boolean(wish.apart) }])
    ];
  });
  const strong = new Set(guests.filter(guest => guest.drink_group === "strong").map(guest => guest.id));
  const adjacent = order.filter((id, i) => strong.has(id) &&
    (sameSide(i, i - 1) && strong.has(order[i - 1]) || sameSide(i, i + 1) && strong.has(order[i + 1]))).length;
  return { checks, adjacent, strong: strong.size };
}

export function suggestSeats(order, count, wishes, guests) {
  const score = candidate => {
    const { checks, adjacent } = seatingReview(candidate, count, wishes, guests);
    return checks.reduce((sum, check) => sum + (check.met ? (check.wish.required ? 100 : 12) : 0), adjacent);
  };
  let best = [...order];
  let bestScore = score(best);
  for (let pass = 0; pass < order.length; pass++) {
    const startScore = bestScore;
    const base = best;
    for (let i = 0; i < base.length - 1; i++) {
      for (let j = i + 1; j < base.length; j++) {
        const candidate = [...base];
        [candidate[i], candidate[j]] = [candidate[j], candidate[i]];
        const next = score(candidate);
        if (next <= bestScore) continue;
        best = candidate;
        bestScore = next;
      }
    }
    if (bestScore === startScore) break;
  }
  return best;
}
