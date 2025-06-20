export function reinterpretAsLocalDate<DateType extends Date>(d: DateType) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  );
}

export function* iterDates<DateType extends Date>(
  start: DateType,
  end: DateType,
  next: (date: DateType) => DateType
): Iterable<DateType> {
  while (start < end) {
    yield start;
    start = next(start);
  }
}
