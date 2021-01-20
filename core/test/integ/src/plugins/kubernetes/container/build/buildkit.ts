/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { getContainerTestGarden } from "../container"
import { KubernetesProvider } from "../../../../../../../src/plugins/kubernetes/config"
import { Garden } from "../../../../../../../src"
import { PluginContext } from "../../../../../../../src/plugin-context"
import {
  ensureBuildkit,
  buildkitDeploymentName,
  buildkitAuthSecretName,
} from "../../../../../../../src/plugins/kubernetes/container/build/buildkit"
import { KubeApi } from "../../../../../../../src/plugins/kubernetes/api"
import { getNamespace } from "../../../../../../../src/plugins/kubernetes/namespace"
import { expect } from "chai"
import { cloneDeep } from "lodash"
import { buildDockerAuthConfig } from "../../../../../../../src/plugins/kubernetes/init"
import { dockerAuthSecretKey } from "../../../../../../../src/plugins/kubernetes/constants"

describe("ensureBuildkit", () => {
  let garden: Garden
  let provider: KubernetesProvider
  let ctx: PluginContext
  let api: KubeApi
  let namespace: string

  before(async () => {
    garden = await getContainerTestGarden("cluster-buildkit")
  })

  beforeEach(async () => {
    provider = <KubernetesProvider>await garden.resolveProvider(garden.log, "local-kubernetes")
    ctx = await garden.getPluginContext(provider)
    api = await KubeApi.factory(garden.log, ctx, provider)
    namespace = await getNamespace({ log: garden.log, ctx, provider })
  })

  after(async () => {
    if (garden) {
      await garden.close()
    }
  })

  it("deploys buildkit if it isn't already in the namespace", async () => {
    try {
      await api.apps.deleteNamespacedDeployment(buildkitDeploymentName, namespace)
    } catch {}

    const deployed = await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })

    // Make sure deployment is there
    await api.apps.readNamespacedDeployment(buildkitDeploymentName, namespace)

    expect(deployed).to.be.true
  })

  it("creates a docker auth secret from configured imagePullSecrets", async () => {
    await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })
    await api.core.readNamespacedSecret(buildkitAuthSecretName, namespace)
  })

  it("creates an empty docker auth secret if there are no imagePullSecrets", async () => {
    const _provider = cloneDeep(provider)
    _provider.config.imagePullSecrets = []

    await ensureBuildkit({
      ctx,
      provider: _provider,
      log: garden.log,
      api,
      namespace,
    })

    const secret = await api.core.readNamespacedSecret(buildkitAuthSecretName, namespace)
    const expectedConfig = await buildDockerAuthConfig([], api)

    const decoded = JSON.parse(Buffer.from(secret.data![dockerAuthSecretKey], "base64").toString())
    expect(decoded).to.eql(expectedConfig)
  })

  it("returns false if buildkit is already deployed", async () => {
    await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })
    const deployed = await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })
    expect(deployed).to.be.false
  })

  it("deploys in rootless mode", async () => {
    try {
      await api.apps.deleteNamespacedDeployment(buildkitDeploymentName, namespace)
    } catch {}

    provider.config.clusterBuildkit = { rootless: true }

    await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })

    const deployment = await api.apps.readNamespacedDeployment(buildkitDeploymentName, namespace)

    expect(deployment.spec.template.spec?.containers[0].securityContext?.runAsUser).to.equal(1000)
  })

  it("deploys again if switching from normal to rootless mode", async () => {
    await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })

    provider.config.clusterBuildkit = { rootless: true }

    const deployed = await ensureBuildkit({
      ctx,
      provider,
      log: garden.log,
      api,
      namespace,
    })
    expect(deployed).to.be.true
  })
})
