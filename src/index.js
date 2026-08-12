/**
 * Khanz094 Audio Space — Worker đếm lượt nghe
 * Tự lưu trữ bằng Cloudflare KV, không phụ thuộc dịch vụ đếm bên thứ 3 nào.
 *
 * Cần: 1 KV namespace được bind vào Worker với tên biến đúng là "VIEWS"
 * (Settings -> Variables -> KV Namespace Bindings -> Variable name: VIEWS).
 *
 * Endpoints:
 *   GET /up?ep=<safeName>     -> tăng lượt nghe của 1 tập lên 1, trả về số mới
 *   GET /count?ep=<safeName>  -> chỉ xem lượt nghe của 1 tập, KHÔNG tăng
 *   GET /counts               -> trả về TẤT CẢ lượt nghe cùng lúc (dùng cho danh sách)
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

function isValidEpisodeName(ep) {
    // Giới hạn ký tự hợp lệ để tránh key rác/tấn công — khớp với cách
    // script.js sinh ra "safeName" (chỉ chữ thường, số, dấu gạch ngang).
    return typeof ep === 'string' && /^[a-z0-9-]{1,200}$/.test(ep);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        if (request.method !== 'GET') {
            return jsonResponse({ error: 'Chỉ hỗ trợ GET' }, 405);
        }

        if (!env.VIEWS) {
            return jsonResponse({ error: 'Worker chưa được bind KV namespace (thiếu biến VIEWS)' }, 500);
        }

        const ep = url.searchParams.get('ep');

        if (path === '/up') {
            if (!isValidEpisodeName(ep)) return jsonResponse({ error: 'Thiếu hoặc sai định dạng tham số ep' }, 400);
            const key = `views:${ep}`;
            const current = parseInt(await env.VIEWS.get(key)) || 0;
            const updated = current + 1;
            await env.VIEWS.put(key, String(updated));
            return jsonResponse({ ep, count: updated });
        }

        if (path === '/count') {
            if (!isValidEpisodeName(ep)) return jsonResponse({ error: 'Thiếu hoặc sai định dạng tham số ep' }, 400);
            const key = `views:${ep}`;
            const count = parseInt(await env.VIEWS.get(key)) || 0;
            return jsonResponse({ ep, count });
        }

        if (path === '/counts') {
            const list = await env.VIEWS.list({ prefix: 'views:' });
            const entries = await Promise.all(
                list.keys.map(async (k) => {
                    const v = await env.VIEWS.get(k.name);
                    return [k.name.replace('views:', ''), parseInt(v) || 0];
                })
            );
            return jsonResponse(Object.fromEntries(entries));
        }

        return jsonResponse({ error: 'Không tìm thấy endpoint. Dùng /up, /count hoặc /counts' }, 404);
    },
};
