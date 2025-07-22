import absurd from "./absurd";

export interface Type<T> {
  parse(v: string): T | undefined;
  serialize(v: T): string;
  equals(x: T, y: T): boolean;
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

export const int: Type<number> = {
  parse(v) {
    const r = parseInt(v);
    return !isNaN(r) ? r : undefined;
  },
  serialize(v) {
    return v.toString();
  },
  equals(x, y) {
    return x === y;
  },
};

export const float: Type<number> = {
  parse(v) {
    const r = parseFloat(v);
    return !isNaN(r) ? r : undefined;
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

export function tuple<T>(
  types: { [K in keyof T]: Type<T[K]> },
  sep: string
): Type<T> {
  return {
    parse(v) {
      const parts = v.split(sep);
      const keys = Object.keys(types) as (keyof T)[];
      if (parts.length !== keys.length) {
        return undefined;
      }

      const parsed: Partial<T> = {};
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        const result = types[key].parse(parts[i]);
        if (result === undefined) {
          return undefined;
        }
        parsed[key] = result;
      }
      return parsed as T;
    },
    serialize(vs) {
      return (Object.entries(types) as [keyof T, Type<T[keyof T]>][])
        .map(([k, t]) => t.serialize(vs[k]))
        .join(sep);
    },

    equals(xs, ys) {
      return (Object.entries(types) as [keyof T, Type<T[keyof T]>][]).every(
        ([k, t]) => t.equals(xs[k], ys[k])
      );
    },
  };
}

export function array<T>(type: Type<T>, sep: string): Type<T[]> {
  return {
    parse(v) {
      if (v === "") {
        return [];
      }
      const parsed = v.split(sep).map((v) => type.parse(v));
      return !parsed.includes(undefined) ? (parsed as T[]) : undefined;
    },
    serialize(vs) {
      return vs.map((v) => type.serialize(v)).join(sep);
    },
    equals(xs, ys) {
      return (
        xs.length === ys.length && xs.every((x, i) => type.equals(x, ys[i]))
      );
    },
  };
}

function literalImpl<T, U extends T>(type: Type<T>, lit: U): Type<U> {
  return {
    parse(v) {
      const parsed = type.parse(v);
      return parsed !== undefined && type.equals(parsed, lit) ? lit : undefined;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serialize(v) {
      return type.serialize(lit);
    },
    equals(x, y) {
      return type.equals(x, y);
    },
  };
}

export function literal<T extends string | number>(lit: T): Type<T> {
  switch (typeof lit) {
    case "string":
      return literalImpl(string, lit);
    case "number":
      return literalImpl(float, lit);
    default:
      return absurd(lit);
  }
}

export function enumImpl<T, U extends T>(
  type: Type<T>,
  values: readonly U[]
): Type<U> {
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
  };
}

export function enum_<const T extends string | number>(
  values: readonly T[]
): Type<T> {
  if (values.every((v) => typeof v === "string")) {
    return enumImpl(string, values);
  }
  if (values.every((v) => typeof v === "number")) {
    return enumImpl(float, values);
  }
  throw "unreachable";
}

export interface MultipleField<T> {
  type: Type<T>;
  multiple: true;
}

export type ScalarField<T, HasDefault extends boolean> = {
  type: Type<T>;
  default: HasDefault extends true ? T : undefined;
};

export type Field<T> = ScalarField<T, boolean> | MultipleField<T>;

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

export function multiple<T>(type: Type<T>): MultipleField<T> {
  return {
    type,
    multiple: true,
  };
}

export type Schema = Record<string, Field<unknown>>;

export function schema<T extends Schema>(schema: T): T {
  return schema;
}

type InferField<F extends Field<unknown>> = F["type"] extends Type<infer T>
  ? F extends MultipleField<unknown>
    ? T[]
    : F extends ScalarField<unknown, true>
    ? T
    : T | undefined
  : never;

export type InferSchema<T extends Schema> = {
  [K in keyof T]: InferField<T[K]>;
};

function isMultipleField<T>(field: Field<T>): field is MultipleField<T> {
  return "multiple" in field && field.multiple;
}

export function defaults<T extends Schema>(schema: T): InferSchema<T> {
  const result = {} as InferSchema<T>;

  for (const key in schema) {
    const field = schema[key];

    result[key] = (isMultipleField(field) ? [] : field.default) as InferField<
      typeof field
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

    if (isMultipleField(field)) {
      const parsed = searchParams.getAll(key).map((v) => field.type.parse(v));
      result[key] = (
        parsed.every((v) => v !== undefined) && parsed.length > 0 ? parsed : []
      ) as InferField<typeof field>;
    } else {
      const defaultValue = field.default ?? undefined;
      const param = searchParams.get(key);
      if (param !== null) {
        const parsed = field.type.parse(param);
        result[key] = (
          parsed !== undefined ? parsed : defaultValue
        ) as InferField<typeof field>;
      } else {
        result[key] = defaultValue as InferField<typeof field>;
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

    if (isMultipleField(field)) {
      const values = value as unknown[];
      for (const item of values) {
        searchParams.append(key, field.type.serialize(item));
      }
    } else if (
      field.default === undefined ||
      !field.type.equals(value, field.default)
    ) {
      searchParams.set(key, field.type.serialize(value));
    }
  }
}

export function equals<T extends Schema>(
  schema: T,
  x: InferSchema<T>,
  y: InferSchema<T>
): boolean {
  for (const key in schema) {
    const field = schema[key];
    if (field.type.equals(x[key], y[key])) {
      return false;
    }
  }
  return true;
}
