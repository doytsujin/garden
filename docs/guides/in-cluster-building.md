---
title: In-Cluster Building
---
# Building images in remote Kubernetes clusters

One of Garden's most powerful features is the ability to build images in your Kubernetes development cluster, thus
avoiding the need for local Kubernetes clusters. This guide covers the requirements for in-cluster building and how
to set it up.

This guide assumes you've already read through the [Remote Kubernetes](./remote-kubernetes.md) guide.

## Security considerations

First off, you should only use in-cluster building in development and testing clusters! Production clusters should not run the builder services for multiple reasons, both to do with resource and security concerns.

You should also avoid using in-cluster building in clusters where you don't control/trust all the code being deployed, i.e. multi-tenant setups (where tenants are external, or otherwise not fully trusted).

## General requirements

In-cluster building works with _most_ Kubernetes clusters, provided they have enough resources allocated and meet some basic requirements. We have tested it on GKE, AKS, EKS, DigitalOcean, and various other custom installations.

The specific requirements vary by the [_build mode_](#build-modes) used, and whether you're using the optional in-cluster registry or not.

In all cases you'll need at least 2GB of RAM _on top of your own service requirements_. More RAM is strongly recommended if you have many concurrent developers or CI builds.

For the [`cluster-docker`](#cluster-docker) and [`kaniko`](#kaniko) modes, and the (optional) in-cluster image registry, support for `PersistentVolumeClaim`s is required, with enough disk space for layer caches and built images. The in-cluster registry also requires support for `hostPort`, and for reaching `hostPort`s from the node/Kubelet. This should work out-of-the-box in most standard setups, but clusters using Cilium for networking may need to configure this specifically, for example.

You can—_and should_—adjust the allocated resources and storage in the provider configuration, under [resources](../reference/providers/kubernetes.md#providersresources) and [storage](../reference/providers/kubernetes.md#providersstorage). See the individual modes below as well for more information on how to allocate resources appropriately.

We also strongly recommend a separate image registry to use for built images. Garden can also—and does by default—deploy an in-cluster registry. The latter is convenient to test things out and may be fine for individual users or small teams. However, we generally recommend using managed container registries (such as ECR, GCR etc.) since they tend to perform better, they scale more easily, and don't need to be operated by your team. See the [Configuring a deployment registry](#configuring-a-deployment-registry) section for more details.

## Build modes

Garden supports multiple methods for building images and making them available to the cluster:

1. [**`kaniko`**](#kaniko) — Individual [Kaniko](https://github.com/GoogleContainerTools/kaniko) pods created for each build in the `garden-system` namespace.
2. [**`cluster-buildkit`**](#cluster-buildkit) _(experimental)_— A [BuildKit](https://github.com/moby/buildkit) deployment created for each project namespace.
3. [**`cluster-docker`**](#cluster-docker) — A single Docker daemon installed in the `garden-system` namespace and shared between users/deployments.
4. `local-docker` — Build using the local Docker daemon on the developer/CI machine before pushing to the cluster/registry.

The `local-docker` mode is set by default. You should definitely use that when using _Docker for Desktop_, _Minikube_ and most other local development clusters.

The other modes—which are why you're reading this guide—all build your images inside your development/testing cluster, so you don't need to run Docker on your machine, and avoid having to build locally and push build artifacts over the wire to the cluster for every change to your code.

The remote building options each have some pros and cons. You'll find more details below but **here are our general recommendations** at the moment:

- [**`kaniko`**](#kaniko) is a solid choice for most cases and is _currently our first recommendation_. It is battle-tested among Garden's most demanding users (including the Garden team itself). It also scales horizontally, since individual Pods are created for each build.
- [**`cluster-buildkit`**](#cluster-buildkit) is a new addition and is for now considered experimental, **but** we are hoping to make that the default in the future. Unlike the other options, which deploy cluster-wide services in the `garden-system` namespace, a [BuildKit](https://github.com/moby/buildkit) Deployment is dynamically created in each project namespace and requires no other cluster-wide services. This mode also offers a _rootless_ option, which runs without any elevated privileges, in clusters that support it.
- [**`cluster-docker`**](#cluster-docker) was the first implementation included with Garden. It's pretty quick and efficient for small team setups, but relies on a single Docker daemon for all users of a cluster, and also requires supporting services in `garden-system` and some operations to keep it from filling its data volume. It is *no longer recommended* and we may deprecate it in future releases.

Let's look at how each mode works in more detail, and how you configure them:

### kaniko

This mode uses an individual [Kaniko](https://github.com/GoogleContainerTools/kaniko) Pod for each image build.

The Kaniko project provides a compelling alternative to the standard Docker daemon because it can run without special privileges on the cluster, and is thus more secure. It may also scale better because it doesn't rely on a single daemon shared across users, so builds are executed in individual Pods and don't share the same resources of a single Pod. This also removes the need to provision another persistent volume, which the Docker daemon needs for its layer cache.

In this mode, builds are executed as follows:

1. Your code (build context) is synchronized to a sync service in the cluster, making it available to Kaniko pods.
2. A Kaniko pod is created for the build in the `garden-system` namespace.
3. Kaniko pulls caches from the [deployment registry](#configuring-a-deployment-registry), builds the image, and then pushes the built image back to the registry, which makes it available to the cluster.

#### Comparison

The trade-off compared to the [`cluster-docker`](#cluster-docker) is generally in performance, partly because it relies only on the Docker registry to cache layers, and has no local cache. There are also some occasional issues and incompatibilities, so your mileage may vary.

Compared to [`cluster-buildkit`](#cluster-buildkit), Kaniko may be a bit slower because it has no local cache. It also requires cluster-wide services to be installed and operated, and for each user to have access to those services in the `garden-system` namespace, which can be a problem in some environments. It is however currently considered more "battle-tested", since the [`cluster-buildkit`](#cluster-buildkit) mode is a recent addition.

#### Configuration and requirements

Enable this by setting `buildMode: kaniko` in your `kubernetes` provider configuration, and running `garden plugins kubernetes cluster-init --env=<env-name>` to install required cluster-wide service.

By default, Garden will install an NFS volume provisioner into `garden-system` in order to be able to efficiently synchronize build sources to the cluster and then attaching those to the Kaniko pods. You can also [specify a storageClass](../reference/providers/kubernetes.md#providersstoragesyncstorageclass) to provide another _ReadWriteMany_ capable storage class to use instead of NFS. This may be advisable if your cloud provider provides a good alternative, or if you already have such a provisioner installed.

Note the difference in how resources for the builder are allocated between Kaniko and the other modes. For this mode, the resource configuration applies to _each Kaniko pod_. See the [builder resources](../reference/providers/kubernetes.md#providersresourcesbuilder) reference for details.

{% hint style="info" %}
If you're using ECR on AWS, you may need to create a cache repository manually for Kaniko to store caches.

That is, if you have a repository like, `my-org/my-image`, you need to manually create a repository next to it called `my-org/my-image/cache`.

You can also select a different name for the cache repository and pass the path to Kaniko via the `--cache-repo` flag, which you can set on the [`extraFlags`](../reference/providers/kubernetes.md#providerskanikoextraFlags) field. See [this GitHub comment](https://github.com/GoogleContainerTools/kaniko/issues/410#issuecomment-433229841) in the Kaniko repo for more details.

This does not appear to be an issue for GCR on GCP. We haven't tested this on other container repositories.
{% endhint %}

You can provide extra arguments to Kaniko via the [`extraFlags`](../reference/providers/kubernetes.md#providerskanikoextraFlags) field. Users with projects with a large number of files should take a look at the `--snapshoteMode=redo` and `--use-new-run` options as these can provide [significant performance improvements](https://github.com/GoogleContainerTools/kaniko/releases/tag/v1.0.0). Please refer to the [official docs](https://github.com/GoogleContainerTools/kaniko#additional-flags) for the full list of available flags.

### cluster-buildkit

With this mode, a [BuildKit](https://github.com/moby/buildkit) Deployment is dynamically created in each project namespace to perform in-cluster builds.

In this mode, builds are executed as follows:

1. BuildKit is automatically deployed to the project namespace, if it hasn't already been deployed there.
2. Your code (build context) is synchronized directly to the BuildKit deployment.
3. BuildKit imports caches from the [deployment registry](#configuring-a-deployment-registry), builds the image, and then pushes the built image and caches back to the registry.

#### Comparison

_This mode is a recent addition and is still considered experimental_. **However**, the general plan is for this to become the recommended approach, because it has several benefits compared to the alternatives.

- It requires **no cluster-wide services or permissions** to be managed, and thus no permissions outside of a single namespace for each user/project.
- By extension, operators/users **don't need to run a cluster initialization command** ahead of building and deploying projects. The BuildKit deployment is automatically installed and updated ahead of builds, as needed.
- It **does not rely on persistent volumes**. Other modes need to either install an NFS provisioner, or for a ReadWriteMany storage class to be provided and configured by the user.
- BuildKit offers a [rootless](https://github.com/moby/buildkit/blob/master/docs/rootless.md) mode (see below for how to enable it and some caveats). If it's supported on your cluster, this coupled with the per-namespace isolation, makes `cluster-buildkit` by far the most secure option.
- BuildKit is a very efficient builder, and uses a combination of local and registry-based caching, so it **should perform better than [`kaniko`](#kaniko)** in most cases, and for long-running namespaces as good as [`cluster-docker`](#cluster-docker).

Beyond being less tested in the wild (for the moment), there are a couple of drawbacks to consider:

- It doesn't scale quite as horizontally as Kaniko, since there is a single deployment per each project namespace, instead of a pod for every single build.
- The local cache is ephemeral, and local to each project namespace. This means users only share a cache at the registry level, much like with Kaniko. The [`cluster-docker`](#cluster-docker) daemon has a persistent local cache that is shared across a cluster (but in turn needs to be maintained and [cleaned up](#cleaning-up-cached-images)). The effect of this is most pronounced for short-lived namespaces, e.g. ones created in CI runs, where the local cache won't exist ahead of the builds.

#### Configuration and requirements

Enable this mode by setting `buildMode: cluster-buildkit` in your `kubernetes` provider configuration. Unlike other remote building modes, no further cluster-wide installation or initialization is required.

In order to enable [rootless](https://github.com/moby/buildkit/blob/master/docs/rootless.md) mode, add the following to your `kubernetes` provider configuration:

```yaml
clusterBuildkit:
  rootless: false
```

*Note that not all clusters can currently support rootless operation, and that you may need to configure your cluster with this in mind. Please see the [BuildKits docs](https://github.com/moby/buildkit/blob/master/docs/rootless.md) for details.*

You should also set the builder resource requests/limits. For this mode, the resource configuration applies to _each BuildKit deployment_, i.e. for _each project namespace_. See the [builder resources](../reference/providers/kubernetes.md#providersresourcesbuilder) reference for details.

### cluster-docker

The `cluster-docker` mode installs a standalone Docker daemon into your cluster, that is then used for builds across all users of the clusters, along with a handful of other supporting services.

{% hint style="warning" %}
The `cluster-docker` build mode may be deprecated in an upcoming release.
{% endhint %}

In this mode, builds are executed as follows:

1. Your code (build context) is synchronized to a sync service in the cluster, making it available to the Docker daemon.
2. A build is triggered in the Docker daemon.
3. The built image is pushed to the [deployment registry](#configuring-a-deployment-registry), which makes it available to the cluster.

#### Comparison

The Docker daemon is of course tried and tested, and is an efficient builder. However, it's not designed with multi-tenancy and is a slightly awkward fit for the context of building images in a shared cluster. It also requires a fair bit of operation and several supporting services deployed along-side it in the `garden-system`  namespace.

*As of now, we only recommend this option for certain scenarios, e.g. clusters serving individuals, small teams or other low-load setups.*

#### Configuration and requirements

Enable this mode by setting `buildMode: cluster-docker` in your `kubernetes` provider configuration.

After enabling this mode, you will need to run `garden plugins kubernetes cluster-init --env=<env-name>` for each applicable environment, in order to install the required cluster-wide services. Those services include the Docker daemon itself, as well as an image registry, a sync service for receiving build contexts, two persistent volumes, an NFS volume provisioner for one of those volumes, and a couple of small utility services.

By default, Garden will install an NFS volume provisioner into `garden-system` in order to be able to efficiently synchronize build sources to the cluster and then attaching those to the Kaniko pods. You can also [specify a storageClass](../reference/providers/kubernetes.md#providersstoragesyncstorageclass) to provide another _ReadWriteMany_ capable storage class to use instead of NFS. This may be advisable if your cloud provider provides a good alternative, or if you already have such a provisioner installed.

Optionally, you can also enable [BuildKit](https://github.com/moby/buildkit) to be used by the Docker daemon. _This is not to be confused with the [`cluster-buildkit`](#cluster-buildkit) build mode, which doesn't use Docker at all._ In most cases, this should work well and offer a bit of added performance, but it remains optional for now. If you have `cluster-docker` set as your `buildMode` you can enable BuildKit for an environment by adding the following to your `kubernetes` provider configuration:

```yaml
clusterDocker:
  enableBuildKit: false
```

Make sure your cluster has enough resources and storage to support the required services, and keep in mind that these
services are shared across all users of the cluster. Please look at the [resources](../reference/providers/kubernetes.md#providersresources) and [storage](../reference/providers/kubernetes.md#providersstorage) sections in the provider reference for
details.

### Local Docker

This is the default mode. It is the least efficient one for remote clusters, but requires no additional configuration or services to be deployed to the cluster. For remote clusters, you do however need to explicitly configure a [deployment registry](#configuring-a-deployment-registry), and obviously you'll need to have Docker running locally.

See the [Local Docker builds](./remote-kubernetes.md) section in the Remote Clusters guide for details.

## Configuring a deployment registry

To deploy a built image to a remote Kubernetes cluster, the image first needs to be pushed to a container registry that is accessible to the cluster. We refer to this as a _deployment registry_. Garden offers two options to handle this process:

1. An in-cluster registry.
2. An external registry, e.g. a cloud provider managed registry like ECR or GCR. **(recommended)**

The in-cluster registry is a simple way to get started with Garden that requires no configuration. To set it up, leave the `deploymentRegistry` field on the `kubernetes` provider config undefined, and run `garden plugins kubernetes cluster-init --env=<env-name>` to install the registry. This is nice and convenient, but is _not a particularly good approach for clusters with many users or lots of builds_. When using the in-cluster registry you need to take care of [cleaning it up routinely](#cleaning-up-cached-images), and it may become a performance and redundancy bottleneck with many users and frequent (or heavy) builds.

So, **for any scenario with a non-trivial amount of users and builds, we strongly suggest configuring a separate registry outside of your cluster.** If your cloud provider offers a managed option, that's usually a good choice.

To configure a deployment registry, you need to specify at least the `deploymentRegistry` field on your `kubernetes` provider, and in many cases you also need to provide a Secret in order to authenticate with the registry via the `imagePullSecrets` field:

```yaml
kind: Project
name: my-project
...
providers:
  - name: kubernetes
    ...
    deploymentRegistry:
      hostname: my-private-registry.com      # <--- the hostname of your registry
      namespace: my-project                  # <--- the namespace to use within your registry
    imagePullSecrets:
      - name: my-deployment-registry-secret  # <--- the name and namespace of a valid Kubernetes imagePullSecret
        namespace: default
```

Now say, if you specify `hostname: my-registry.com` and `namespace: my-project-id` for the `deploymentRegistry` field, and you have a container module named `some-module` in your project, it will be tagged and pushed to `my-registry.com/my-project-id/some-module:v:<module-version>` after building. That image ID will be then used in Kubernetes manifests when running containers.

For this to work, you in most cases also need to provide the authentication necessary for both the cluster to read the image and for the builder to push to the registry. We use the same format and mechanisms as Kubernetes _imagePullSecrets_ for this. See [this guide](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/) for how to create the secret, **but keep in mind that for this context, the authentication provided must have write privileges to the configured registry and namespace.**

{% hint style="warning" %}
Note: If you're using the [`kaniko`](#kaniko) or [`cluster-docker`](#cluster-docker) build mode, you need to re-run `garden plugins kubernetes cluster-init` any time you add or modify imagePullSecrets, for them to work.
{% endhint %}

## Publishing images

You can publish images that have been built in your cluster, using the `garden publish` command.

The only caveat is that you currently need to have Docker running locally, and you need to have authenticated with the
target registry. When publishing, we pull the image from the in-cluster registry to the local Docker daemon, and then
go on to push it from there. We do this to avoid having to (re-)implement all the various authentication methods (and
by extension key management) involved in pushing directly from the cluster.

As usual, you need to specify the `image` field on the `container` module in question. For example:

```yaml
kind: Module
name: my-module
image: my-repo/my-image:v1.2.3   # <- omit the tag here if you'd like to use the Garden-generated version tag
...
```

## Cleaning up cached images

In order to avoid disk-space issues in the cluster when using the in-cluster registry and/or either of the [`kaniko`](#kaniko) or [`cluster-docker`](#cluster-docker) build modes, the `kubernetes` provider exposes a utility command:

```sh
garden --env=<your-environment> plugins kubernetes cleanup-cluster-registry
```

The command does the following:

1. Looks through all Pods in the cluster to see which images/tags are in use, and flags all other images as deleted in the in-cluster registry and.
2. Restarts the registry in read-only mode.
3. Runs the registry garbage collection.
4. Restarts the registry again without the read-only mode.
5. When using the [`cluster-docker`](#cluster-docker) build mode, we additionally untag in the Docker daemon all images that are no longer in the registry, and then clean up the dangling image layers by running `docker image prune`.

There are plans to do this automatically when disk-space runs low, but for now you can run this manually or set up your own cron jobs.

**You can avoid this entirely by using a remote [deployment registry](#configuring-a-deployment-registry) and the [`cluster-buildkit`](#cluster-buildkit) build mode.**

## Pulling base images from private registries

The in-cluster builder may need to be able to pull base images from a private registry, e.g. if your Dockerfile starts with something like this:

```dockerfile
FROM my-private-registry.com/my-image:tag
```

where `my-private-registry.com` requires authorization.

For this to work, you need to create a registry secret in your cluster (see [this guide](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/) for how to create the secret) and then configure the [imagePullSecrets](../reference/providers/kubernetes.md#providersimagepullsecrets) field in your `kubernetes` provider configuration:

```yaml
kind: Project
name: my-project
...
providers:
  - name: kubernetes
    ...
    imagePullSecrets:
      # The name of the registry auth secret you created.
    - name: my-registry-secret
      # Change this if you store the secret in another namespace.
      namespace: default
```

This registry auth secret will then be copied and passed to the in-cluster builder. You can specify as many as you like, and they will be merged together.

{% hint style="warning" %}
Note: If you're using the [`kaniko`](#kaniko) or [`cluster-docker`](#cluster-docker) build mode, you need to re-run `garden plugins kubernetes cluster-init` any time you add or modify imagePullSecrets, for them to work when pulling base images!
{% endhint %}
