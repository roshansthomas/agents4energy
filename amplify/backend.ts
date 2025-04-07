import path from 'path';
import { fileURLToPath } from 'url';
import { Stack } from 'aws-cdk-lib';
import { regulatoryAgentBuilder } from './agents/regulatory/regulatoryAgent';
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import {
  data,
  invokeBedrockAgentFunction,
  getStructuredOutputFromLangchainFunction,
  productionAgentFunction,
  planAndExecuteAgentFunction,
} from './data/resource';
import { preSignUp } from './functions/preSignUp/resource';
import { storage } from './storage/resource';

import * as cdk from 'aws-cdk-lib'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import {
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3Deployment,
  aws_ec2 as ec2,
  aws_lambda as lambda,
  custom_resources as cr,
  Aspects
} from 'aws-cdk-lib'

import { AwsSolutionsChecks } from 'cdk-nag'

import { productionAgentBuilder } from "./agents/production/productionAgent"
import { maintenanceAgentBuilder } from "./agents/maintenance/maintenanceAgent"
import { AppConfigurator } from './custom/appConfigurator'
import { cdkNagSupperssionsHandler } from './custom/cdkNagHandler';

import { addLlmAgentPolicies } from './functions/utils/cdkUtils'
import { petrophysicsAgentBuilder } from './agents/petrophysicsAgent/petrophysicsAgent';

const resourceTags = {
  Project: 'agents-for-energy',
  Environment: 'dev',
  AgentsForEnergy: 'true'
}

const backend = defineBackend({
  auth,
  data,
  storage,
  invokeBedrockAgentFunction,
  getStructuredOutputFromLangchainFunction,
  productionAgentFunction,
  planAndExecuteAgentFunction,
  preSignUp
});

const bedrockRuntimeDataSource = backend.data.resources.graphqlApi.addHttpDataSource(
  "bedrockRuntimeDS",
  `https://bedrock-runtime.${backend.auth.stack.region}.amazonaws.com`,
  {
    authorizationConfig: {
      signingRegion: backend.auth.stack.region,
      signingServiceName: "bedrock",
    },
  }
);

const bedrockAgentDataSource = backend.data.resources.graphqlApi.addHttpDataSource(
  "bedrockAgentDS",
  `https://bedrock-agent.${backend.auth.stack.region}.amazonaws.com`,
  {
    authorizationConfig: {
      signingRegion: backend.auth.stack.region,
      signingServiceName: "bedrock",
    },
  }
);

bedrockRuntimeDataSource.grantPrincipal.addToPrincipalPolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:bedrock:${backend.auth.stack.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
      `arn:aws:bedrock:${backend.auth.stack.region}::foundation-model/anthropic.*`,
    ],
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  })
);

bedrockAgentDataSource.grantPrincipal.addToPrincipalPolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:bedrock:${backend.auth.stack.region}:${backend.auth.stack.account}:*`,
    ],
    actions: [
      "bedrock:ListAgents",
      "bedrock:ListAgentAliases"
    ],
  })
);

backend.invokeBedrockAgentFunction.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:bedrock:${backend.auth.stack.region}:${backend.auth.stack.account}:agent-alias/*`,
    ],
    actions: ["bedrock:InvokeAgent"],
  }
  )
)

backend.invokeBedrockAgentFunction.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:bedrock:${backend.auth.stack.region}::foundation-model/*`,
      `arn:aws:bedrock:us-*::foundation-model/*`,
    ],
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  })
);

backend.getStructuredOutputFromLangchainFunction.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    resources: [
      `arn:aws:bedrock:${backend.auth.stack.region}:${backend.auth.stack.account}:inference-profile/*`,
      `arn:aws:bedrock:us-*::foundation-model/*`,
    ],
    actions: ["bedrock:InvokeModel"],
  })
)

const networkingStack = backend.createStack('networkingStack')
const rootStack = cdk.Stack.of(networkingStack).nestedStackParent
if (!rootStack) throw new Error('Root stack not found')

backend.addOutput({
  custom: {
    api_id: backend.data.resources.graphqlApi.apiId,
    root_stack_name: rootStack.stackName
  },
});

const vpc = new ec2.Vpc(networkingStack, 'A4E-VPC', {
  ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
  maxAzs: 3,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  subnetConfiguration: [
    {
      cidrMask: 24,
      name: 'public',
      subnetType: ec2.SubnetType.PUBLIC,
    },
    {
      cidrMask: 24,
      name: 'private-with-egress',
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    },
  ],
  flowLogs: {
    'flow-log': {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.ALL,
    }
  }
});

// Delete the VPC when the cloudformation template is deleted
vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)

function applyTagsToRootStack() {
  if (!rootStack) throw new Error('Root stack not found')
  //Apply tags to all the nested stacks
  Object.entries(resourceTags).map(([key, value]) => {
    cdk.Tags.of(rootStack).add(key, value)
  })
  cdk.Tags.of(rootStack).add('rootStackName', rootStack.stackName)
}
applyTagsToRootStack()

///////////////////////////////////////////////////////////
/////// Create the Maintenance Agent Stack /////////////////
///////////////////////////////////////////////////////////
const maintenanceAgentStack = backend.createStack('maintAgentStack')
const {defaultDatabaseName, maintenanceAgent, maintenanceAgentAlias} = maintenanceAgentBuilder(maintenanceAgentStack, {
  vpc: vpc,
  s3Deployment: uploadToS3Deployment, // This causes the assets here to not deploy until the s3 upload is complete.
  s3Bucket: backend.storage.resources.bucket,
})

backend.addOutput({
  custom: {
    maintenanceAgentId: maintenanceAgent.attrAgentId,
    maintenanceAgentAliasId: maintenanceAgentAlias.attrAgentAliasId,
  },
})

///////////////////////////////////////////////////////////
/////// Create the Regulatory Agent Stack /////////////////
///////////////////////////////////////////////////////////
const regulatoryAgentStack = backend.createStack('regAgentStack')
const { regulatoryAgent, regulatoryAgentAlias, metric } = regulatoryAgentBuilder(regulatoryAgentStack, {
  vpc: vpc,
  s3Deployment: uploadToS3Deployment, // This causes the assets here to not deploy until the s3 upload is complete.
  s3Bucket: backend.storage.resources.bucket
})
backend.addOutput({
  custom: {
    regulatoryAgentId: regulatoryAgent.attrAgentId,
    regulatoryAgentAliasId: regulatoryAgentAlias.attrAgentAliasId,
  },
})

///////////////////////////////////////////////////////////
/////// Create the Petrophysics Agent Stack ///////////////
///////////////////////////////////////////////////////////
const petrophysicsAgentStack = backend.createStack('petroAgentStack')
const { petrophysicsAgent, petrophysicsAgentAlias } = petrophysicsAgentBuilder(petrophysicsAgentStack, {
  vpc: vpc,
  s3Deployment: uploadToS3Deployment, // This causes the assets here to not deploy until the s3 upload is complete.
  s3Bucket: backend.storage.resources.bucket
})
backend.addOutput({
  custom: {
    petrophysicsAgentId: petrophysicsAgent.attrAgentId,
    petrophysicsAgentAliasId: petrophysicsAgentAlias.attrAgentAliasId,
  },
})



///////////////////////////////////////////////////////////
/////// Create the Configurator Stack /////////////////////
///////////////////////////////////////////////////////////
// This stack configures the GraphQL API and adds a hook to the conginto user pool to check email address domain before allowing sign up.

// Create a stack with the resources to configure the app
const configuratorStack = backend.createStack('configuratorStack')

new AppConfigurator(configuratorStack, 'appConfigurator', {
  hydrocarbonProductionDb: hydrocarbonProductionDb,
  defaultProdDatabaseName: defaultProdDatabaseName,
  athenaWorkgroup: athenaWorkgroup,
  // athenaPostgresCatalog: athenaPostgresCatalog,
  s3Bucket: backend.storage.resources.bucket,
  appSyncApi: backend.data.resources.graphqlApi,
  preSignUpFunction: backend.preSignUp.resources.lambda,
  cognitoUserPool: backend.auth.resources.userPool,
})
