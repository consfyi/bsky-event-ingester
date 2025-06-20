import { TZDate } from "@date-fns/tz";
import { addMonths } from "date-fns";

export function reinterpretAsLocalDate(tzDate: TZDate) {
  return new Date(
    tzDate.getFullYear(),
    tzDate.getMonth(),
    tzDate.getDate(),
    tzDate.getHours(),
    tzDate.getMinutes(),
    tzDate.getSeconds(),
    tzDate.getMilliseconds()
  );
}

export function* iterDates<DateType extends Date>(
  start: DateType,
  end: DateType,
  next: (date: DateType) => DateType
): Generator<DateType> {
  while (start < end) {
    yield start;
    start = next(start);
  }
}
