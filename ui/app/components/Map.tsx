import { match } from "@formatjs/intl-localematcher";
import { useLingui } from "@lingui/react/macro";
import {
  Box,
  Indicator,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  language_script_pairs,
  layers,
  namedFlavor,
} from "@protomaps/basemaps";
import { IconMapPinFilled } from "@tabler/icons-react";
import {
  AttributionControl,
  Map as Maplibre,
  Marker,
  Popup,
  StyleSpecification,
  useMap,
} from "@vis.gl/react-maplibre";
import { getDay, isAfter } from "date-fns";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { useMemo, useState } from "react";
import { ConWithPost, hookifyPromise, useNow } from "~/hooks";
import { ConRow } from "./ConsList";
import classes from "./Map.module.css";

const API_KEY = "a4d6fb59d9d6e179";

const SUPPORTED_LANGUAGES = language_script_pairs.map((v) => v.lang);

function makeStyle({
  colorScheme,
  locale,
}: {
  colorScheme: "light" | "dark";
  locale: string;
}): StyleSpecification {
  return {
    version: 8,
    sources: {
      protomaps: {
        type: "vector",
        url: `https://api.protomaps.com/tiles/v4.json?key=${API_KEY}`,
        attribution:
          '<a href="https://openstreetmap.org/copyright" target="_blank">© OpenStreetMap Contributors</a>',
      },
    },
    glyphs:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${colorScheme}`,
    layers: layers("protomaps", namedFlavor(colorScheme), {
      lang: match([locale], SUPPORTED_LANGUAGES, "en"),
    }),
    transition: { duration: 0, delay: 0 },
  };
}

function Pin({
  con,
  lat,
  lng,
  showPopup,
  setShowPopup,
}: {
  con: ConWithPost;
  lat: number;
  lng: number;
  showPopup: boolean;
  setShowPopup: (v: boolean) => void;
}) {
  const theme = useMantineTheme();

  const color = [
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "indigo",
    "violet",
  ][getDay(con.start)];

  const variant =
    con.post.viewer != null && con.post.viewer.like != null
      ? "filled"
      : "light";

  const colors = theme.variantColorResolver({
    theme,
    color,
    variant,
  });

  const mapRef = useMap();
  const now = useNow();
  const active = isAfter(now, con.start) && !isAfter(now, con.end);

  return (
    <>
      <Marker
        latitude={lat}
        longitude={lng}
        onClick={(e) => {
          e.originalEvent.stopPropagation();
          if (mapRef.current != null && showPopup) {
            mapRef.current.flyTo({ center: [lng, lat] });
          }
          setShowPopup(true);
        }}
        style={{
          zIndex:
            con.post.viewer != null && con.post.viewer.like != null
              ? 2
              : active
              ? 1
              : 0,
        }}
        subpixelPositioning
      >
        <Box style={{ marginTop: "-100%" }}>
          <Indicator
            position="top-start"
            color="green"
            processing
            size={12}
            withBorder
            disabled={!active}
            zIndex={2}
            offset={6}
          >
            <IconMapPinFilled
              size={32}
              color={
                variant == "light"
                  ? `color-mix(in srgb, var(--mantine-color-${color}-filled), var(--mantine-color-body) 90%)`
                  : colors.background
              }
              style={{
                stroke: colors.color,
              }}
            />
          </Indicator>
        </Box>
      </Marker>
      {showPopup ? (
        <Popup
          maxWidth="none"
          latitude={lat}
          longitude={lng}
          offset={[0, -36]}
          style={{ zIndex: 100 }}
        >
          <ConRow
            con={con}
            showMonthInIcon
            showEndDateOnly={false}
            showLocation={false}
            showFollowed
            showLikeButton
            showBigIcon={false}
            showDuration={false}
          />
        </Popup>
      ) : null}
    </>
  );
}

async function getMyLocation(
  signal?: AbortSignal
): Promise<{ lat: number; lng: number }> {
  const resp = await fetch("https://free.freeipapi.com/api/json", {
    signal,
  });
  if (!resp.ok) {
    throw resp;
  }
  const { latitude, longitude } = await resp.json();
  return { lat: latitude, lng: longitude };
}

const useMyLocation = hookifyPromise(
  (async () => {
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort();
    }, 1000);
    try {
      return await getMyLocation(ctrl.signal);
    } catch {
      return null;
    }
  })()
);

export default function Map({
  cons,
  initialCenter,
  setCenter,
}: {
  cons: ConWithPost[];
  initialCenter: { lat: number; lng: number; zoom: number } | null;
  setCenter(center: { lat: number; lng: number; zoom: number }): void;
}) {
  const colorScheme = useComputedColorScheme();
  const { i18n, t } = useLingui();
  const [selected, setSelected] = useState<string | null>();

  const myLatLng = useMyLocation();

  const center =
    initialCenter != null
      ? initialCenter
      : myLatLng != null
      ? { ...myLatLng, zoom: 3 }
      : { lat: 0, lng: 0, zoom: 0 };

  const style = useMemo(
    () => makeStyle({ colorScheme, locale: i18n.locale }),
    [colorScheme, t]
  );

  return (
    <Box
      className={`${colorScheme} ${classes.map}`}
      style={{ position: "relative", height: "100%", zIndex: 0 }}
    >
      <Maplibre
        ref={(ref) => {
          if (ref == null) {
            return;
          }
          const map = ref.getMap();
          map.dragRotate.disable();
          map.touchPitch.disable();
          map.touchZoomRotate.disableRotation();
          map.keyboard.disableRotation();
        }}
        onMoveEnd={(e) => {
          setCenter({
            lat: e.viewState.latitude,
            lng: e.viewState.longitude,
            zoom: e.viewState.zoom,
          });
        }}
        onClick={() => {
          setSelected(null);
        }}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: center.zoom,
        }}
        attributionControl={false}
        mapStyle={style}
        style={{
          position: "absolute",
          height: "100%",
          top: 0,
          left: 0,
        }}
      >
        <AttributionControl
          compact={false}
          style={{
            background: "none",
            fontSize: "var(--mantine-font-size-xs)",
            borderTopLeftRadius: "var(--mantine-radius-default)",
            fontWeight: 500,
            WebkitTextStroke: "0.1px",
            WebkitTextStrokeColor: "var(--mantine-color-default)",
          }}
        />
        {cons.flatMap((con) =>
          con.geocoded != null && con.geocoded.latLng != null
            ? [
                <Pin
                  key={con.identifier}
                  con={con}
                  showPopup={con.identifier == selected}
                  setShowPopup={(v) => {
                    setSelected(v ? con.identifier : null);
                  }}
                  lat={con.geocoded.latLng[0]}
                  lng={con.geocoded.latLng[1]}
                />,
              ]
            : []
        )}
      </Maplibre>
    </Box>
  );
}
