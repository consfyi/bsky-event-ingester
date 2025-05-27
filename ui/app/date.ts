import { TZDate } from "@date-fns/tz";

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
