import type { ObjectIndex } from "../store/objects";
import { parseCalendar } from "./calendar";
import { indexSpan } from "./timerange";

/** Validate a body and derive the index row fields. Throws InvalidCalendar. */
export function indexObject(text: string): ObjectIndex {
  const cal = parseCalendar(text);
  const { span, recurring } = indexSpan(cal);
  return { uid: cal.uid, component: cal.component, dtstartUtc: span.start, dtendUtc: span.end, isRecurring: recurring };
}
