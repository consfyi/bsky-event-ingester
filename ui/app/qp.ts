export interface Type<T> {
  parse(v: string): T | undefined;
  serialize(v: T): string;
  equals(x: T, y: T): boolean;
}

export interface EnumType<T> extends Type<T> {
  values: readonly T[];
}

export const string: Type<string> = {
  parse(v) {
    return v;
  },
  serialize(v) {
    return v;
  },
  equals(x, y) {
    return x === y;
  },
};

export const number: Type<number> = {
  parse(v) {
    return parseFloat(v);
  },
  serialize(v) {
    return v.toString();
  },
  equals(x, y) {
    return x === y;
  },
};

export const boolean: Type<boolean> = {
  parse(v) {
    return v === "true" || v === "1";
  },
  serialize(v) {
    return v ? "1" : "0";
  },
  equals(x, y) {
    return x === y;
  },
};

function literalImpl<T, U extends T>(type: Type<T>, lit: U): Type<U> {
  return {
    parse(v) {
      const parsed = type.parse(v);
      return parsed !== undefined && type.equals(parsed, lit) ? lit : undefined;
    },
    serialize(v) {
      return type.serialize(lit);
    },
    equals(x, y) {
      return type.equals(x, y);
    },
  };
}

export function literal<T extends string | number>(lit: T): Type<T> {
  if (typeof lit === "string") {
    return literalImpl(string, lit);
  }
  if (typeof lit === "number") {
    return literalImpl(number, lit);
  }
  throw "unreachable";
}

export function enumImpl<T, U extends T>(
  type: Type<T>,
  values: readonly U[]
): EnumType<U> {
  const set = new Set<T>(values);

  return {
    parse(v) {
      const parsed = type.parse(v);
      return parsed !== undefined && set.has(parsed)
        ? (parsed as U)
        : undefined;
    },
    serialize(v) {
      return type.serialize(v);
    },
    equals(x, y) {
      return type.equals(x, y);
    },
    values,
  };
}

export function enum_<T extends string | number>(
  values: readonly T[]
): EnumType<T> {
  if (values.every((v) => typeof v === "string")) {
    return enumImpl(string, values);
  }
  if (values.every((v) => typeof v === "number")) {
    return enumImpl(number, values);
  }
  throw "unreachable";
}

export interface MultipleField<T, HasDefault extends boolean> {
  type: Type<T>;
  multiple: true;
  default: HasDefault extends true ? readonly T[] : undefined;
}

export type ScalarField<T, HasDefault extends boolean> = {
  type: Type<T>;
  default: HasDefault extends true ? T : undefined;
};

export type Field<T, HasDefault extends boolean> =
  | ScalarField<T, HasDefault>
  | MultipleField<T, HasDefault>;

export function scalar<T>(type: Type<T>): ScalarField<T, false>;
export function scalar<T>(type: Type<T>, defaultValue: T): ScalarField<T, true>;
export function scalar<T>(
  type: Type<T>,
  defaultValue?: T
): ScalarField<T, boolean> {
  return {
    type,
    default: defaultValue,
  };
}

export function multiple<T>(type: Type<T>): MultipleField<T, false>;
export function multiple<T>(
  type: Type<T>,
  defaultValue: readonly T[]
): MultipleField<T, true>;
export function multiple<T>(
  type: Type<T>,
  defaultValue?: readonly T[]
): MultipleField<T, boolean> {
  return {
    type,
    multiple: true,
    default: defaultValue,
  };
}

export type Schema = Record<string, Field<any, boolean>>;

export function schema<T extends Schema>(schema: T): T {
  return schema;
}

type InferField<F extends Field<any, boolean>> = F extends {
  multiple: true;
}
  ? InferType<F["type"]>[]
  : F extends ScalarField<any, true>
  ? InferType<F["type"]>
  : InferType<F["type"]> | undefined;

export type InferType<T> = T extends Type<infer U> ? U : never;

export type InferSchema<T extends Schema> = {
  [K in keyof T]: InferField<T[K]>;
};

export function defaults<T extends Schema>(schema: T): InferSchema<T> {
  const result = {} as InferSchema<T>;

  for (const key in schema) {
    const field = schema[key];

    result[key] = (field.default ??
      ("multiple" in field && field.multiple ? [] : undefined)) as InferType<
      typeof field.type
    >;
  }

  return result;
}

export function parse<T extends Schema>(
  schema: T,
  searchParams: URLSearchParams
): InferSchema<T> {
  const result = {} as InferSchema<T>;

  for (const key in schema) {
    const field = schema[key];

    if ("multiple" in field && field.multiple) {
      const defaultValue = field.default ?? [];
      const parsed = searchParams.getAll(key).map((v) => field.type.parse(v));
      result[key] = (
        parsed.every((v) => v !== undefined) && parsed.length > 0
          ? parsed
          : defaultValue
      ) as InferType<typeof field.type>;
    } else {
      const defaultValue = field.default ?? undefined;
      const param = searchParams.get(key);
      if (param !== null) {
        const parsed = field.type.parse(param);
        result[key] = parsed !== undefined ? parsed : defaultValue;
      } else {
        result[key] = defaultValue;
      }
    }
  }

  return result;
}

export function serialize<T extends Schema>(
  schema: T,
  record: InferSchema<T>,
  searchParams: URLSearchParams
) {
  for (const key in schema) {
    const field = schema[key];
    const value = record[key];

    if (value === undefined) {
      continue;
    }

    if ("multiple" in field && field.multiple) {
      const values = value as any[];
      if (
        field.default === undefined ||
        values.length !== field.default.length ||
        !field.default.every((v, i) => field.type.equals(values[i], v))
      ) {
        for (const item of values) {
          searchParams.append(key, field.type.serialize(item));
        }
      }
    } else {
      if (
        field.default === undefined ||
        !field.type.equals(value, field.default)
      ) {
        searchParams.set(key, field.type.serialize(value));
      }
    }
  }
}
