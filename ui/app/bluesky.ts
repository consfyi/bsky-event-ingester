import type {} from "@atcute/atproto";
import type { AppBskyFeedLike } from "@atcute/bluesky";
import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type {
  PostView,
  ThreadViewPost,
} from "@atcute/bluesky/types/app/feed/defs";
import type { Like } from "@atcute/bluesky/types/app/feed/getLikes";
import type { LabelerViewDetailed } from "@atcute/bluesky/types/app/labeler/defs";
import {
  Client as AtcuteClient,
  buildFetchHandler,
  simpleFetchHandler,
} from "@atcute/client";
import type {
  ActorIdentifier,
  Cid,
  Did,
  Nsid,
  ResourceUri,
} from "@atcute/lexicons";
import {
  configureOAuth,
  createAuthorizationUrl,
  deleteStoredSession,
  finalizeAuthorization,
  getSession,
  listStoredSessions,
  OAuthUserAgent,
  resolveFromIdentity,
  resolveFromService,
  Session,
} from "@atcute/oauth-browser-client";
import clientMetadata from "../public/client-metadata.json";
import { LABELER_DID } from "./config";

export async function startLogin(handle: string | null) {
  let identity = undefined;
  let metadata;

  if (handle != null) {
    const resp = await resolveFromIdentity(handle);
    identity = resp.identity;
    metadata = resp.metadata;
  } else {
    const resp = await resolveFromService("https://bsky.social");
    metadata = resp.metadata;
  }

  const authUrl = await createAuthorizationUrl({
    identity,
    metadata,
    scope: "atproto transition:generic",
  });
  window.location.assign(authUrl);
}

export class Client {
  private oauthUserAgent: OAuthUserAgent | null;
  private rpc: AtcuteClient;

  constructor(session: Session | null = null) {
    this.oauthUserAgent = session != null ? new OAuthUserAgent(session) : null;
    this.rpc = new AtcuteClient({
      handler:
        this.oauthUserAgent != null
          ? buildFetchHandler(this.oauthUserAgent)
          : simpleFetchHandler({
              service: "https://public.api.bsky.app",
            }),
    });
  }

  get did() {
    return this.oauthUserAgent != null
      ? this.oauthUserAgent.session.info.sub
      : null;
  }

  async logout() {
    if (this.oauthUserAgent == null) {
      return;
    }
    try {
      await this.oauthUserAgent.signOut();
    } catch (e) {
      deleteStoredSession(this.oauthUserAgent.session.info.sub);
    }
  }

  async *getAuthorPosts(actor: ActorIdentifier): AsyncGenerator<PostView> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.feed.getAuthorFeed", {
        params: {
          actor,
          limit: LIMIT,
          cursor,
          includePins: false,
          filter: "posts_no_replies",
        },
      });
      if (!ok) {
        throw data.error;
      }

      for (const feedView of data.feed) {
        yield feedView.post;
      }
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async getProfile(actor: ActorIdentifier): Promise<ProfileViewDetailed> {
    const { ok, data } = await this.rpc.get("app.bsky.actor.getProfile", {
      params: { actor },
    });
    if (!ok) {
      throw data.error;
    }
    return data;
  }

  async getPostThread(uri: ResourceUri): Promise<ThreadViewPost> {
    const { ok, data } = await this.rpc.get("app.bsky.feed.getPostThread", {
      params: { uri, depth: 0, parentHeight: 0 },
    });
    if (!ok) {
      throw data.error;
    }
    if (data.thread.$type != "app.bsky.feed.defs#threadViewPost") {
      throw data;
    }
    return data.thread;
  }

  async getLabelerView(did: Did): Promise<LabelerViewDetailed> {
    const { ok, data } = await this.rpc.get("app.bsky.labeler.getServices", {
      params: { dids: [did], detailed: true },
    });

    if (!ok) {
      throw data.error;
    }
    const {
      views: [view],
    } = data;
    return view as LabelerViewDetailed;
  }

  async *getFollows(actor: ActorIdentifier): AsyncGenerator<ProfileView> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.graph.getFollows", {
        params: { actor, limit: LIMIT, cursor },
      });
      if (!ok) {
        throw data.error;
      }

      yield* data.follows;
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async *getLikes(uri: ResourceUri): AsyncGenerator<Like> {
    const LIMIT = 100;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("app.bsky.feed.getLikes", {
        params: { uri, limit: LIMIT, cursor },
      });
      if (!ok) {
        throw data.error;
      }

      yield* data.likes;
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async *getLabels(did: Did): AsyncGenerator<string> {
    const LIMIT = 250;
    let cursor = "";
    while (true) {
      const { ok, data } = await this.rpc.get("com.atproto.label.queryLabels", {
        params: {
          sources: [LABELER_DID],
          uriPatterns: [did],
          limit: LIMIT,
          cursor,
        },
      });
      if (!ok) {
        throw data.error;
      }

      for (const label of data.labels) {
        yield label.val;
      }
      if (!data.cursor) {
        break;
      }
      cursor = data.cursor;
    }
  }

  async unlike(uri: ResourceUri) {
    const [repo, collection, rkey] = uri.replace(/^at:\/\//, "").split("/");

    const { ok, data } = await this.rpc.post("com.atproto.repo.deleteRecord", {
      input: {
        collection: collection as Nsid,
        repo: repo as Did,
        rkey,
      },
    });
    if (!ok) {
      throw data.error;
    }
  }

  async like(uri: ResourceUri, cid: Cid) {
    if (this.did == null) {
      return;
    }

    const { ok, data } = await this.rpc.post("com.atproto.repo.createRecord", {
      input: {
        collection: "app.bsky.feed.like",
        repo: this.did,
        record: {
          $type: "app.bsky.feed.like",
          subject: {
            uri,
            cid,
          },
          createdAt: new Date().toISOString(),
        } satisfies AppBskyFeedLike.Main,
      },
    });
    if (!ok) {
      throw data.error;
    }

    return data.uri;
  }
}

export async function createClient() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search
  );

  configureOAuth({
    metadata: {
      client_id: clientMetadata.client_id,
      redirect_uri: clientMetadata.redirect_uris[0],
    },
  });

  let session: Session | null = null;
  if (params.size > 0) {
    try {
      session = await finalizeAuthorization(params);
    } catch (e) {
      // Do nothing.
    }
  } else {
    const sessions = listStoredSessions();
    if (sessions.length > 0) {
      const did = sessions[0];
      try {
        session = await getSession(did, { allowStale: false });
      } catch (e) {
        deleteStoredSession(did);
      }
    }
  }

  return new Client(session);
}
