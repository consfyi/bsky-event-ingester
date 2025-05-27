import { TZDate } from "@date-fns/tz";

export function asLocalDate(tzDate: TZDate) {
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
