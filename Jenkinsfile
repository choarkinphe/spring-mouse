pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    environment {
        GIT_URL = 'git@git.wiguo.cn:service/spring-mouse.git'
        DOCKER_IMAGE = 'docker.wiguo.cn/spring-mouse:latest'
        REMOTE_DIR = '/docker/spring-mouse/.jenkins-bootstrap'
        SSH_CREDENTIALS = '7e6a3e12-7cb1-47b4-99dd-ae7c249319f4'
    }

    parameters {
        choice(
            name: 'DEPLOY_TARGET',
            choices: ['青山-main'],
            description: '选择部署目标服务器'
        )
        gitParameter(
            name: 'GIT_BRANCH',
            description: '要部署的 Git 分支',
            type: 'PT_BRANCH',
            branch: '',
            defaultValue: 'origin/master',
            useRepository: '${GIT_URL}'
        )
        booleanParam(
            name: 'ONLY_BUILD',
            defaultValue: false,
            description: '只构建并推送 Docker 镜像，不部署'
        )
        booleanParam(
            name: 'NO_CACHE_BUILD',
            defaultValue: false,
            description: '禁用 Docker 构建缓存'
        )
    }

    stages {
        stage('检出代码') {
            steps {
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: "${params.GIT_BRANCH}"]],
                    userRemoteConfigs: [[
                        url: "${GIT_URL}",
                        credentialsId: "${SSH_CREDENTIALS}"
                    ]]
                ])
                script {
                    env.GIT_SHORT = sh(
                        script: 'git rev-parse --short=12 HEAD',
                        returnStdout: true
                    ).trim()
                    echo "准备构建镜像：${env.DOCKER_IMAGE}（revision=${env.GIT_SHORT}）"
                }
            }
        }

        // 与 OAPI 保持一致的“构建 → 核验 → 推送”流程。
        // 9Router 是 Next.js standalone 构建，构建失败通常源于 .next 缓存或
        // tracing 产物异常，命中特征时自动 --no-cache 重试一次。
        stage('构建 Docker 镜像') {
            options {
                // npm install + Next.js 全量构建在 CI 上耗时较长；超时即判失败，
                // 避免网络阻塞时构建无限挂起。
                timeout(time: 60, unit: 'MINUTES')
            }
            steps {
                script {
                    def noCacheFlag = params.NO_CACHE_BUILD ? '--no-cache' : ''
                    def buildCommand = "docker build --pull ${noCacheFlag} --build-arg APP_BUILD_VERSION=${env.GIT_SHORT} -t ${env.DOCKER_IMAGE} ."
                    def buildStatus = sh(
                        script: """#!/usr/bin/env bash
set -o pipefail
${buildCommand} 2>&1 | tee docker-build.log
""",
                        returnStatus: true
                    )

                    // 旧版 Docker 的中间镜像缓存偶发丢失 / Next.js 构建缓存损坏时，
                    // 仅针对典型特征错误自动无缓存重试一次。
                    if (buildStatus != 0) {
                        def buildLog = readFile('docker-build.log')
                        if (!params.NO_CACHE_BUILD && (buildLog.contains('invalid from flag value') || buildLog.contains('Failed to re-copy assets') || buildLog.contains('.next/standalone'))) {
                            echo '检测到构建缓存异常，使用 --no-cache 自动重试一次。'
                            sh """#!/usr/bin/env bash
set -euxo pipefail
docker build \\
  --pull \\
  --no-cache \\
  --build-arg APP_BUILD_VERSION=${env.GIT_SHORT} \\
  -t ${env.DOCKER_IMAGE} \\
  .
"""
                        } else {
                            error('Docker 镜像构建失败；请检查 docker-build.log。')
                        }
                    }

                    sh """#!/usr/bin/env bash
set -euxo pipefail
docker image inspect ${env.DOCKER_IMAGE} \\
  --format '镜像ID={{.Id}} 构建版本={{index .Config.Labels "org.opencontainers.image.revision"}}'
docker push ${env.DOCKER_IMAGE}
"""
                }
            }
        }

        stage('部署到目标服务器') {
            when {
                expression { return !params.ONLY_BUILD }
            }
            steps {
                script {
                    sshPublisher(
                        publishers: [
                            sshPublisherDesc(
                                configName: "${params.DEPLOY_TARGET}",
                                transfers: [
                                    sshTransfer(
                                        sourceFiles: 'docker-compose.yml',
                                        removePrefix: '',
                                        remoteDirectory: "${REMOTE_DIR}",
                                        execCommand: '''
                                            #!/bin/bash
                                            set -euo pipefail

                                            TARGET_DIR="/www/docker/spring-mouse"
                                            TARGET_COMPOSE="$TARGET_DIR/docker-compose.yml"
                                            TARGET_ENV="$TARGET_DIR/.env"
                                            BOOTSTRAP_DIR="$TARGET_DIR/.jenkins-bootstrap"
                                            BOOTSTRAP_COMPOSE="$BOOTSTRAP_DIR/docker-compose.yml"

                                            cleanup_bootstrap() {
                                                rm -f "$BOOTSTRAP_COMPOSE"
                                                rmdir "$BOOTSTRAP_DIR" 2>/dev/null || true
                                            }
                                            trap cleanup_bootstrap EXIT

                                            mkdir -p "$TARGET_DIR"

                                            if [ -e "$TARGET_COMPOSE" ] || [ -L "$TARGET_COMPOSE" ]; then
                                                echo "✅ 保留生产环境现有 docker-compose.yml，不执行覆盖"
                                            elif [ -s "$BOOTSTRAP_COMPOSE" ]; then
                                                install -m 0644 "$BOOTSTRAP_COMPOSE" "$TARGET_COMPOSE"
                                                echo "✅ 生产环境缺少 docker-compose.yml，已从代码仓库初始化"
                                            else
                                                echo "❌ 代码仓库中的 docker-compose.yml 未成功传输"
                                                exit 1
                                            fi

                                            test -s "$TARGET_COMPOSE" || {
                                                echo "❌ 生产环境 docker-compose.yml 不存在或为空"
                                                exit 1
                                            }

                                            # spring-mouse 服务依赖 env_file，缺 .env 会导致 compose 起不来。
                                            if [ ! -s "$TARGET_ENV" ]; then
                                                echo "❌ 缺少 $TARGET_ENV（参考仓库 .env.example 配置后重试）"
                                                exit 1
                                            fi

                                            cd "$TARGET_DIR"
                                            echo "📦 使用生产环境运行配置："
                                            docker-compose config

                                            # 提取 spring-mouse 服务的 image：不依赖 config 的服务参数过滤
                                            # （老版 docker-compose 可能不支持），按 2 空格缩进识别服务块。
                                            # compose config 按字母序输出，headroom 在前，不能全局取第一个 image。
                                            echo "🔎 镜像校验脚本 v3"
                                            EXPECTED_IMAGE=$(docker-compose config | awk '
                                                /^  [^ ]/ { in_svc = ($1 == "spring-mouse:") }
                                                in_svc && $1 == "image:" { print $2; exit }
                                            ' | tr -d '"' | tr -d '[:space:]')
                                            echo "🔎 解析到 spring-mouse 镜像: ${EXPECTED_IMAGE:-空}"
                                            if [ "$EXPECTED_IMAGE" != "docker.wiguo.cn/spring-mouse:latest" ]; then
                                                echo "❌ 运行镜像必须统一使用 docker.wiguo.cn/spring-mouse:latest，当前为: ${EXPECTED_IMAGE:-空}"
                                                exit 1
                                            fi

                                            PULL_OK=0
                                            for i in 1 2 3; do
                                                echo "🔄 拉取镜像 $EXPECTED_IMAGE（第 $i 次）"
                                                if docker-compose pull spring-mouse; then
                                                    PULL_OK=1
                                                    break
                                                fi
                                                sleep 10
                                            done
                                            if [ "$PULL_OK" -ne 1 ]; then
                                                echo "❌ 镜像拉取失败，终止部署，禁止继续使用本地旧镜像"
                                                exit 1
                                            fi

                                            EXPECTED_IMAGE_ID=$(docker image inspect "$EXPECTED_IMAGE" --format '{{.Id}}')
                                            EXPECTED_VERSION=$(docker image inspect "$EXPECTED_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
                                            if [ -z "$EXPECTED_IMAGE_ID" ] || [ -z "$EXPECTED_VERSION" ]; then
                                                echo "❌ latest 镜像缺少镜像 ID 或构建版本信息"
                                                exit 1
                                            fi

                                            # 只重建主服务；headroom（ghcr.io 外部镜像）由 depends_on 自动带起。
                                            docker-compose up -d --force-recreate --remove-orphans spring-mouse

                                            HOST_PORT=$(docker-compose port spring-mouse 8008 | awk -F: '{print $NF}')
                                            HEALTH_OK=0
                                            # Next.js standalone 冷启动较慢，给足 90 秒。
                                            for i in $(seq 1 45); do
                                                if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
                                                    HEALTH_OK=1
                                                    break
                                                fi
                                                sleep 2
                                            done
                                            if [ "$HEALTH_OK" -ne 1 ]; then
                                                echo "❌ 新容器健康检查失败"
                                                docker-compose logs --tail=100 spring-mouse
                                                exit 1
                                            fi

                                            # /api/version 无需鉴权；返回 200 且带 currentVersion 说明
                                            # Next.js 业务路由已加载。502/504 = 服务未就绪，
                                            # 404 = 前后端版本错位，都必须阻止发布成功。
                                            VERSION_BODY="/tmp/spring-mouse-version.json"
                                            VERSION_STATUS=$(curl -sS \
                                                -o "$VERSION_BODY" \
                                                -w '%{http_code}' \
                                                --max-time 30 \
                                                "http://127.0.0.1:${HOST_PORT}/api/version" || true)
                                            if [ "$VERSION_STATUS" != "200" ]; then
                                                echo "❌ 版本接口校验失败（HTTP ${VERSION_STATUS:-000}）"
                                                cat "$VERSION_BODY" 2>/dev/null || true
                                                docker-compose logs --tail=100 spring-mouse
                                                exit 1
                                            fi
                                            APP_VERSION=$(awk -F'"' '/"currentVersion"/ {print $4; exit}' "$VERSION_BODY")
                                            if [ -z "$APP_VERSION" ]; then
                                                echo "❌ 版本接口未返回 currentVersion"
                                                cat "$VERSION_BODY"
                                                exit 1
                                            fi
                                            rm -f "$VERSION_BODY"
                                            echo "✅ 业务路由已加载（app 版本 $APP_VERSION）"

                                            CONTAINER_IMAGE=$(docker inspect spring-mouse --format '{{.Config.Image}}')
                                            CONTAINER_IMAGE_ID=$(docker inspect spring-mouse --format '{{.Image}}')
                                            ACTUAL_VERSION=$(docker inspect spring-mouse --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
                                            echo "期望镜像: $EXPECTED_IMAGE"
                                            echo "容器镜像: $CONTAINER_IMAGE"
                                            echo "期望镜像 ID: $EXPECTED_IMAGE_ID"
                                            echo "容器镜像 ID: $CONTAINER_IMAGE_ID"
                                            echo "期望构建版本: $EXPECTED_VERSION"
                                            echo "容器构建版本: $ACTUAL_VERSION"

                                            if [ "$CONTAINER_IMAGE" != "$EXPECTED_IMAGE" ] \
                                                || [ "$CONTAINER_IMAGE_ID" != "$EXPECTED_IMAGE_ID" ] \
                                                || [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
                                                echo "❌ 容器未运行本次拉取的 latest 镜像"
                                                exit 1
                                            fi

                                            BUILD_INFO=$(docker exec spring-mouse cat /app/build-info.json)
                                            echo "镜像构建信息:"
                                            echo "$BUILD_INFO"
                                            BUILD_REVISION=$(echo "$BUILD_INFO" | awk -F'"' '/"revision"/ {print $4; exit}')
                                            if [ "$BUILD_REVISION" != "$EXPECTED_VERSION" ]; then
                                                echo "❌ 容器内 build-info 与镜像 label 不一致: $BUILD_REVISION"
                                                exit 1
                                            fi

                                            docker-compose ps
                                            echo "✅ 部署完成，构建版本: $EXPECTED_VERSION（app 版本: $APP_VERSION）"
                                        '''
                                    )
                                ],
                                usePromotionTimestamp: false,
                                useWorkspaceInPromotion: false,
                                verbose: true
                            )
                        ]
                    )
                }
            }
        }

        stage('清理 Jenkins 悬空镜像') {
            steps {
                sh 'docker image prune -f'
            }
        }
    }

    post {
        failure {
            echo '❌ 构建或部署失败，请检查镜像标签、拉取结果和版本核验输出'
        }
        success {
            echo "✨ 发布成功：${env.DOCKER_IMAGE}"
            sh 'echo "部署镜像 ${DOCKER_IMAGE}，完成于 $(date)" > deploy.log'
        }
    }
}
