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

export const number: Type<number> = {
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

export function tuple<Ts extends any[]>(
  types: { [K in keyof Ts]: Type<Ts[K]> },
  sep: string
): Type<Ts> {
  return {
    parse(v) {
      const parts = v.split(sep);

      if (parts.length !== types.length) {
        return undefined;
      }

      const parsed: any[] = [];
      for (let i = 0; i < types.length; i++) {
        const result = types[i].parse(parts[i]);
        if (result === undefined) {
          return undefined;
        }
        parsed.push(result);
      }

      return parsed as Ts;
    },
    serialize(v) {
      return v.map((item, i) => types[i].serialize(item)).join(sep);
    },
    equals(xs, ys) {
      return (
        xs.length === ys.length && xs.every((x, i) => types[i].equals(x, ys[i]))
      );
    },
  };
}

export function object<T>(
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

      const parsed: any = {};
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        const result = types[key].parse(parts[i]);
        if (result === undefined) {
          return undefined;
        }
        parsed[key] = result;
      }
      return parsed;
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

export function sepBy<T>(type: Type<T>, sep: string): Type<T[]> {
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

export function enum_<T extends string | number>(
  values: readonly T[]
): Type<T> {
  if (values.every((v) => typeof v === "string")) {
    return enumImpl(string, values);
  }
  if (values.every((v) => typeof v === "number")) {
    return enumImpl(number, values);
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

export type Field<T> = ScalarField<T, any> | MultipleField<T>;

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

export type Schema = Record<string, Field<any>>;

export function schema<T extends Schema>(schema: T): T {
  return schema;
}

type InferField<F extends Field<any>> = F extends MultipleField<any>
  ? InferType<F["type"]>[]
  : F extends ScalarField<any, true>
  ? InferType<F["type"]>
  : InferType<F["type"]> | undefined;

export type InferType<T> = T extends Type<infer U> ? U : never;

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

    result[key] = (isMultipleField(field) ? [] : field.default) as InferType<
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

    if (isMultipleField(field)) {
      const parsed = searchParams.getAll(key).map((v) => field.type.parse(v));
      result[key] = (
        parsed.every((v) => v !== undefined) && parsed.length > 0 ? parsed : []
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

    if (isMultipleField(field)) {
      const values = value as any[];
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
