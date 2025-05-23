import { LabelerPolicies } from "@atcute/bluesky/types/app/labeler/defs";
import type { ActorIdentifier, Did, ResourceUri } from "@atcute/lexicons";
import { Endpoint, Entity, schema } from "@data-client/endpoint";
import { useController } from "@data-client/react";
import { useClient } from "./hooks";
import type { Preferences as ActorPreferences } from "@atcute/bluesky/types/app/actor/defs";

export class Profile extends Entity {
  static key = "Profile";

  public did: Did | undefined;
  public handle: string | undefined;
  public displayName: string | undefined;
  public avatar: string | undefined;

  pk() {
    return this.did;
  }
}

export class Post extends Entity {
  static key = "Post";

  public uri: ResourceUri | undefined;
  public cid: string | undefined;
  public likeCount: number | undefined;
  public viewer: { like?: ResourceUri | undefined } | undefined;

  pk() {
    return this.uri;
  }
}

export class Like extends Entity {
  static key = "Like";

  public actor: Profile | undefined;

  pk() {
    return this.actor?.did;
  }

  static schema = {
    actor: Profile,
  };
}

export class Preferences extends Entity {
  static key = "Preferences";

  public preferences: ActorPreferences | undefined;

  pk() {
    return "preferences";
  }
}

export class LabelerView extends Entity {
  static key = "LabelerView";

  public uri: ResourceUri | undefined;
  public policies: LabelerPolicies | undefined;

  pk() {
    return this.uri;
  }
}

export function useGetAuthorPosts() {
  const client = useClient();

  return new Endpoint(
    async ({ actor }: { actor: ActorIdentifier }) => {
      const posts = [];
      for await (const postView of client.getAuthorPosts(actor)) {
        posts.push(Post.fromJS(postView));
      }
      return posts;
    },
    {
      name: "getAuthorPosts",
      schema: new schema.Collection([Post]),
    }
  );
}

export function useGetProfile() {
  const client = useClient();

  return new Endpoint(
    async ({ did }: { did: Did }) => {
      return Profile.fromJS(await client.getProfile(did));
    },
    {
      name: "getProfile",
      schema: Profile,
    }
  );
}

export function useGetLikes() {
  const client = useClient();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const likes = [];
      for await (const like of client.getLikes(uri)) {
        likes.push(Like.fromJS({ ...like, actor: Profile.fromJS(like.actor) }));
      }
      return likes;
    },
    {
      name: "getLikes",
      schema: new schema.Collection([Like]),
    }
  );
}

export function useGetFollows() {
  const client = useClient();

  return new Endpoint(
    async ({ actor }: { actor: ActorIdentifier }) => {
      const follows = [];
      for await (const follow of client.getFollows(actor)) {
        follows.push(Profile.fromJS(follow));
      }
      return follows;
    },
    {
      name: "getFollows",
      schema: new schema.Collection([Profile]),
    }
  );
}

export function useGetLabelerView() {
  const client = useClient();

  return new Endpoint(
    async ({ did }: { did: Did }) => {
      return LabelerView.fromJS(await client.getLabelerView(did));
    },
    {
      name: "getLabelerView",
      schema: LabelerView,
    }
  );
}

export function useLikePost() {
  const client = useClient();
  const ctrl = useController();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const post = ctrl.get(Post, { uri }, ctrl.getState());
      if (post == null) {
        throw "post not found";
      }

      if (post.viewer == null || post.viewer.like != null) {
        return;
      }

      post.viewer.like = await client.like(uri, post.cid!);
      post.likeCount = (post.likeCount ?? 0) + 1;

      ctrl.set(Post, { uri }, post);
    },
    {
      name: "likePost",
      sideEffect: true,
    }
  );
}

export function useUnlikePost() {
  const client = useClient();
  const ctrl = useController();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const post = ctrl.get(Post, { uri }, ctrl.getState());
      if (post == null) {
        throw "post not found";
      }

      if (post.viewer == null || post.viewer.like == null) {
        return;
      }

      await client.deleteRecord(post.viewer.like);

      post.viewer.like = undefined;
      post.likeCount = (post.likeCount ?? 0) - 1;

      ctrl.set(Post, { uri }, post);
    },
    {
      name: "unlikePost",
      sideEffect: true,
    }
  );
}

export function useGetPreferences() {
  const client = useClient();

  return new Endpoint(
    async () => {
      if (client.did == null) {
        return Preferences.fromJS({});
      }

      return Preferences.fromJS({ preferences: await client.getPreferences() });
    },
    {
      name: "getPreferences",
      schema: Preferences,
    }
  );
}

export function usePutPreferences() {
  const client = useClient();

  return new Endpoint(
    async ({ preferences }: { preferences: ActorPreferences }) => {
      await client.putPreferences(preferences);
      return Preferences.fromJS({ preferences });
    },
    {
      name: "putPreferences",
      sideEffect: true,
      schema: Preferences,
    }
  );
}
