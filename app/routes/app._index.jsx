import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

/*
=====================================
SERVER
=====================================
*/

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

/*
=====================================
CLIENT
=====================================
*/

export default function Index() {
  return (
    <s-page heading="Welcome to the App">
      <div style={{ marginTop: "40px" }}>
        <s-section>
          <s-stack direction="block" gap="base">
            <s-heading>🎉 Welcome to the app</s-heading>

            <s-paragraph>
              This is your custom Shopify embedded application.
            </s-paragraph>

            <s-paragraph>
              You can now start building your own features like:
            </s-paragraph>

            <s-unordered-list>
              <s-list-item>Magento → Shopify product sync</s-list-item>
              <s-list-item>Product link synchronization</s-list-item>
              <s-list-item>Metafield automation</s-list-item>
            </s-unordered-list>

            <s-paragraph>
              Use the navigation menu to explore available tools.
            </s-paragraph>
          </s-stack>
        </s-section>
      </div>

    </s-page>
  );
}

/*
=====================================
HEADERS
=====================================
*/

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};