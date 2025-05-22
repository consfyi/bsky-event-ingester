import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { Like as OriginalLike } from "@atcute/bluesky/types/app/feed/getLikes";
import {
  LabelerPolicies,
  LabelerViewDetailed,
} from "@atcute/bluesky/types/app/labeler/defs";
import type { ActorIdentifier, Did, ResourceUri } from "@atcute/lexicons";
import { Endpoint, schema } from "@data-client/endpoint";
import { useController } from "@data-client/react";
import { useClient } from "./hooks";

export class Profile {
  public did: Did;
  public handle: string;
  public displayName: string | undefined;
  public avatar: string | undefined;

  constructor(profileView: ProfileView | ProfileViewDetailed) {
    this.did = profileView.did;
    this.handle = profileView.handle;
    this.displayName = profileView.displayName;
    this.avatar = profileView.avatar;
  }

  pk() {
    return this.did;
  }

  public static Entity = schema.Entity(this, {
    key: this.name,
  });
}

export class Post {
  public uri: ResourceUri;
  public cid: string;
  public likeCount: number | undefined;
  public viewer: { like?: ResourceUri | undefined } | undefined;

  constructor(postView: PostView) {
    this.uri = postView.uri;
    this.cid = postView.cid;
    this.likeCount = postView.likeCount;
    this.viewer = postView.viewer;
  }

  pk() {
    return this.uri;
  }

  public static Entity = schema.Entity(this, {
    key: this.name,
  });
}

export class Like {
  public actor: Profile;

  constructor(like: OriginalLike) {
    this.actor = new Profile(like.actor);
  }

  pk() {
    return this.actor.did;
  }

  public static Entity = schema.Entity(this, {
    key: this.name,
    schema: {
      actor: Profile.Entity,
    },
  });
}

export class LabelerView {
  public uri: ResourceUri;
  public policies: LabelerPolicies;

  constructor(labelerViewDetailed: LabelerViewDetailed) {
    this.uri = labelerViewDetailed.uri;
    this.policies = labelerViewDetailed.policies;
  }

  pk() {
    return this.uri;
  }

  public static Entity = schema.Entity(this, {
    key: this.name,
  });
}

export function useGetAuthorPosts() {
  const client = useClient();

  return new Endpoint(
    async ({ actor }: { actor: ActorIdentifier }) => {
      const posts = [];
      for await (const postView of client.getAuthorPosts(actor)) {
        posts.push(new Post(postView));
      }
      return posts;
    },
    {
      name: "getAuthorPosts",
      schema: new schema.Collection([Post.Entity]),
    }
  );
}

export function useGetProfile() {
  const client = useClient();

  return new Endpoint(
    async ({ did }: { did: Did }) => {
      return new Profile(await client.getProfile(did));
    },
    {
      name: "getProfile",
      schema: Profile.Entity,
    }
  );
}

export function useGetLikes() {
  const client = useClient();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const likes = [];
      for await (const like of client.getLikes(uri)) {
        likes.push(new Like(like));
      }
      return likes;
    },
    {
      name: "getLikes",
      schema: new schema.Collection([Like.Entity]),
    }
  );
}

export function useGetFollows() {
  const client = useClient();

  return new Endpoint(
    async ({ actor }: { actor: ActorIdentifier }) => {
      const follows = [];
      for await (const follow of client.getFollows(actor)) {
        follows.push(new Profile(follow));
      }
      return follows;
    },
    {
      name: "getFollows",
      schema: new schema.Collection([Profile.Entity]),
    }
  );
}

export function useGetLabelerView() {
  const client = useClient();

  return new Endpoint(
    async ({ did }: { did: Did }) => {
      return new LabelerView(await client.getLabelerView(did));
    },
    {
      name: "getLabelerView",
      schema: LabelerView.Entity,
    }
  );
}

export function useLikePost() {
  const client = useClient();
  const controller = useController();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const post = controller.get(Post.Entity, { uri }, controller.getState());
      if (post == null) {
        throw "post not found";
      }

      if (post.viewer == null || post.viewer.like != null) {
        return;
      }

      post.viewer.like = await client.like(uri, post.cid);
      post.likeCount = (post.likeCount ?? 0) + 1;

      return post;
    },
    {
      name: "likePost",
      sideEffect: true,
      schema: Post.Entity,
    }
  );
}

export function useUnlikePost() {
  const client = useClient();
  const controller = useController();

  return new Endpoint(
    async ({ uri }: { uri: ResourceUri }) => {
      const post = controller.get(Post.Entity, { uri }, controller.getState());
      if (post == null) {
        throw "post not found";
      }

      if (post.viewer == null || post.viewer.like == null) {
        return;
      }

      await client.deleteRecord(post.viewer.like);

      post.viewer.like = undefined;
      post.likeCount = (post.likeCount ?? 0) - 1;

      return post;
    },
    {
      name: "unlikePost",
      sideEffect: true,
      schema: Post.Entity,
    }
  );
}
