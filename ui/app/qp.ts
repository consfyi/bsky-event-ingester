export interface ScalarField<T> {
  parse(v: string): T | undefined;
  serialize(v: T): string;
  equals(x: T, y: T): boolean;
}

export const string: ScalarField<string> = {
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

export const int: ScalarField<number> = {
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

export const float: ScalarField<number> = {
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

export const boolean: ScalarField<boolean> = {
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
  types: { [K in keyof T]: ScalarField<T[K]> },
  sep: string
): ScalarField<T> {
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
      return (Object.entries(types) as [keyof T, ScalarField<T[keyof T]>][])
        .map(([k, t]) => t.serialize(vs[k]))
        .join(sep);
    },

    equals(xs, ys) {
      return (
        Object.entries(types) as [keyof T, ScalarField<T[keyof T]>][]
      ).every(([k, t]) => t.equals(xs[k], ys[k]));
    },
  };
}

export function array<T>(type: ScalarField<T>, sep: string): ScalarField<T[]> {
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

export function literal<const T extends string | number>(
  values: readonly T[]
): ScalarField<T> {
  const type = (
    typeof values[0] === "number" ? float : string
  ) as ScalarField<T>;

  const allowed = new Set(values);
  return {
    parse(v) {
      const parsed = type.parse(v);
      return parsed !== undefined && allowed.has(parsed) ? parsed : undefined;
    },
    serialize(v) {
      return type.serialize(v);
    },
    equals(x, y) {
      return type.equals(x, y);
    },
  };
}

export interface MultipleField<T> {
  kind: "multiple";
  type: ScalarField<T>;
  multiple: true;
}

export interface DefaultField<T> {
  kind: "default";
  type: ScalarField<T>;
  default: T;
}

export type Field<T> = ScalarField<T> | DefaultField<T> | MultipleField<T>;

export function default_<T>(
  type: ScalarField<T>,
  defaultValue: T
): DefaultField<T> {
  return {
    kind: "default",
    type,
    default: defaultValue,
  };
}

export function multiple<T>(type: ScalarField<T>): MultipleField<T> {
  return {
    kind: "multiple",
    type,
    multiple: true,
  };
}

export type Schema = Record<string, Field<unknown>>;

export function schema<T extends Schema>(schema: T): T {
  return schema;
}

type InferField<F extends Field<unknown>> = F extends MultipleField<infer T>
  ? T[]
  : F extends DefaultField<infer T>
  ? T
  : F extends ScalarField<infer T>
  ? T | undefined
  : never;

export type InferSchema<T extends Schema> = {
  [K in keyof T]: InferField<T[K]>;
};

function isDefaultField<T>(f: Field<T>): f is DefaultField<T> {
  return "kind" in f && f.kind === "default";
}

function isMultipleField<T>(f: Field<T>): f is MultipleField<T> {
  return "kind" in f && f.kind === "multiple";
}

function isType<T>(f: Field<T>): f is ScalarField<T> {
  return !isDefaultField(f) && !isMultipleField(f);
}

export function defaults<T extends Schema>(schema: T): InferSchema<T> {
  const result = {} as InferSchema<T>;

  for (const key in schema) {
    const field = schema[key];

    result[key] = (
      isMultipleField(field)
        ? []
        : isDefaultField(field)
        ? field.default
        : undefined
    ) as InferField<typeof field>;
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
    } else if (isDefaultField(field)) {
      const param = searchParams.get(key);
      if (param !== null) {
        const parsed = field.type.parse(param);
        result[key] = (
          parsed !== undefined ? parsed : field.default
        ) as InferField<typeof field>;
      } else {
        result[key] = undefined as InferField<typeof field>;
      }
    } else {
      const param = searchParams.get(key);
      result[key] = (
        param !== null ? field.parse(param) : undefined
      ) as InferField<typeof field>;
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
      isDefaultField(field) &&
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
    const type = isType(field) ? field : field.type;
    if (!type.equals(x[key], y[key])) {
      return false;
    }
  }
  return true;
}
