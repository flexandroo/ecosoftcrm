export const DEAL_STATUSES = [
  { id: "new", label: "Нове", tone: "info" },
  { id: "contacting", label: "Зв’язуємось", tone: "warning" },
  { id: "confirmed", label: "Підтверджене", tone: "primary" },
  { id: "awaiting_shipment", label: "Очікує відправлення", tone: "neutral" },
  { id: "shipped", label: "Відправлене", tone: "violet" },
  { id: "completed", label: "Успішно завершене", tone: "success" },
  { id: "cancelled", label: "Скасоване", tone: "danger" },
];

export const DEAL_TYPES = [
  { id: "order", label: "Замовлення" },
  { id: "callback", label: "Зворотний дзвінок" },
  { id: "contact", label: "Консультація" },
  { id: "manual", label: "Створено вручну" },
];

export const PAYMENT_METHODS = [
  { id: "cod", label: "Післяплата" },
  { id: "bank_transfer", label: "Переказ за реквізитами" },
  { id: "cash", label: "Готівка" },
  { id: "none", label: "Не визначено" },
];

export const PAYMENT_STATUSES = [
  { id: "unpaid", label: "Не оплачено" },
  { id: "paid", label: "Оплачено" },
  { id: "not_required", label: "Не застосовується" },
];

export const STATUS_IDS = new Set(DEAL_STATUSES.map((item) => item.id));
export const TYPE_IDS = new Set(DEAL_TYPES.map((item) => item.id));
export const PAYMENT_METHOD_IDS = new Set(PAYMENT_METHODS.map((item) => item.id));
export const PAYMENT_STATUS_IDS = new Set(PAYMENT_STATUSES.map((item) => item.id));

export function statusLabel(id) {
  return DEAL_STATUSES.find((item) => item.id === id)?.label ?? id;
}
