import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

/// ============================================================
/// ACHE OBRA - JISA IA
/// ============================================================
///
/// Recursos desta tela:
/// - conversa por texto;
/// - câmera;
/// - galeria;
/// - seleção de documentos/arquivos;
/// - envio de texto + anexos ao backend;
/// - análise de imagens e documentos;
/// - geração de imagens;
/// - edição de imagens usando foto de referência;
/// - exibição da imagem gerada dentro da conversa.
///
/// Backend:
/// POST /ia/perguntar
/// POST /ia/gerar-imagem
/// ============================================================

class IaPage extends StatefulWidget {
  const IaPage({super.key});

  @override
  State<IaPage> createState() => _IaPageState();
}

class _IaPageState extends State<IaPage> {
  static const String _baseUrl = 'https://acheobra-ai-backend.onrender.com';

  static const String _endpointPerguntar = '$_baseUrl/ia/perguntar';

  static const String _endpointGerarImagem = '$_baseUrl/ia/gerar-imagem';

  static const Color _azulAcheObra = Color(0xFF1A2C42);
  static const Color _laranjaAcheObra = Color(0xFFFF8C00);

  static const int _maxArquivos = 5;
  static const int _maxArquivoBytes = 18 * 1024 * 1024;

  final TextEditingController _mensagemController = TextEditingController();

  final ScrollController _scrollController = ScrollController();
  final FocusNode _campoFocus = FocusNode();
  final ImagePicker _imagePicker = ImagePicker();

  final List<_MensagemChat> _mensagens = [];
  final List<_AnexoSelecionado> _anexos = [];

  bool _enviando = false;

  _RequisicaoAnterior? _ultimaRequisicao;

  @override
  void initState() {
    super.initState();

    _mensagens.add(
      const _MensagemChat(
        texto: 'Olá! Eu sou a Jisa, a inteligência artificial do Ache Obra. '
            'Posso ajudar com construção, reformas, materiais, profissionais, '
            'planejamento de obras e pedidos de orçamento.\n\n'
            'Também posso analisar fotos e documentos e criar imagens para '
            'ajudar você a visualizar ideias para sua obra.\n\n'
            'Como posso ajudar?',
        autor: _AutorMensagem.ia,
      ),
    );
  }

  @override
  void dispose() {
    _mensagemController.dispose();
    _scrollController.dispose();
    _campoFocus.dispose();
    super.dispose();
  }

  // ============================================================
  // ANEXOS
  // ============================================================

  Future<void> _abrirMenuAnexos() async {
    if (_enviando) return;

    FocusScope.of(context).unfocus();

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(22),
        ),
      ),
      builder: (sheetContext) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 42,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade300,
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                const Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Adicionar à conversa',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: _azulAcheObra,
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: Color(0xFFFFF3E0),
                    child: Icon(
                      Icons.camera_alt_outlined,
                      color: _laranjaAcheObra,
                    ),
                  ),
                  title: const Text('Câmera'),
                  subtitle: const Text(
                    'Tire uma foto para a Jisa analisar',
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _selecionarImagem(ImageSource.camera);
                  },
                ),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: Color(0xFFEAF0F6),
                    child: Icon(
                      Icons.photo_library_outlined,
                      color: _azulAcheObra,
                    ),
                  ),
                  title: const Text('Galeria'),
                  subtitle: const Text(
                    'Selecione uma ou mais imagens',
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _selecionarImagensGaleria();
                  },
                ),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: Color(0xFFF2F2F2),
                    child: Icon(
                      Icons.attach_file_rounded,
                      color: _azulAcheObra,
                    ),
                  ),
                  title: const Text('Arquivo ou documento'),
                  subtitle: const Text(
                    'PDF, Word, Excel, PowerPoint, TXT e outros',
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _selecionarArquivos();
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _selecionarImagem(ImageSource source) async {
    if (_anexos.length >= _maxArquivos) {
      _mostrarSnack(
        'Você pode enviar no máximo $_maxArquivos arquivos por mensagem.',
      );
      return;
    }

    try {
      final XFile? arquivo = await _imagePicker.pickImage(
        source: source,
        imageQuality: 88,
        maxWidth: 2200,
        maxHeight: 2200,
      );

      if (arquivo == null) return;

      final bytes = await arquivo.readAsBytes();

      if (!_validarTamanhoArquivo(bytes.length, arquivo.name)) {
        return;
      }

      final mimeType = _mimeImagemPorNome(
        arquivo.name,
        fallback: arquivo.mimeType,
      );

      if (!mounted) return;

      setState(() {
        _anexos.add(
          _AnexoSelecionado(
            nome: arquivo.name.isEmpty
                ? 'foto_${DateTime.now().millisecondsSinceEpoch}.jpg'
                : arquivo.name,
            mimeType: mimeType,
            bytes: bytes,
          ),
        );
      });
    } catch (erro) {
      debugPrint('[Jisa IA] Erro ao selecionar imagem: $erro');

      if (!mounted) return;

      _mostrarSnack(
        'Não foi possível acessar a imagem. Verifique as permissões do aplicativo.',
      );
    }
  }

  Future<void> _selecionarImagensGaleria() async {
    final disponiveis = _maxArquivos - _anexos.length;

    if (disponiveis <= 0) {
      _mostrarSnack(
        'Você pode enviar no máximo $_maxArquivos arquivos por mensagem.',
      );
      return;
    }

    try {
      final List<XFile> imagens = await _imagePicker.pickMultiImage(
        imageQuality: 88,
        maxWidth: 2200,
        maxHeight: 2200,
      );

      if (imagens.isEmpty) return;

      final selecionadas = imagens.take(disponiveis).toList();
      final novosAnexos = <_AnexoSelecionado>[];

      for (final arquivo in selecionadas) {
        final bytes = await arquivo.readAsBytes();

        if (bytes.length > _maxArquivoBytes) {
          if (mounted) {
            _mostrarSnack(
              'O arquivo "${arquivo.name}" ultrapassa 18 MB e não foi adicionado.',
            );
          }
          continue;
        }

        novosAnexos.add(
          _AnexoSelecionado(
            nome: arquivo.name.isEmpty
                ? 'imagem_${DateTime.now().millisecondsSinceEpoch}.jpg'
                : arquivo.name,
            mimeType: _mimeImagemPorNome(
              arquivo.name,
              fallback: arquivo.mimeType,
            ),
            bytes: bytes,
          ),
        );
      }

      if (!mounted) return;

      setState(() {
        _anexos.addAll(novosAnexos);
      });

      if (imagens.length > disponiveis) {
        _mostrarSnack(
          'Foram adicionadas apenas $disponiveis imagens. '
          'O limite é de $_maxArquivos arquivos por mensagem.',
        );
      }
    } catch (erro) {
      debugPrint('[Jisa IA] Erro ao abrir galeria: $erro');

      if (!mounted) return;

      _mostrarSnack(
        'Não foi possível abrir a galeria.',
      );
    }
  }

  Future<void> _selecionarArquivos() async {
    final disponiveis = _maxArquivos - _anexos.length;

    if (disponiveis <= 0) {
      _mostrarSnack(
        'Você pode enviar no máximo $_maxArquivos arquivos por mensagem.',
      );
      return;
    }

    try {
      final resultado = await FilePicker.platform.pickFiles(
        allowMultiple: true,
        withData: true,
        type: FileType.custom,
        allowedExtensions: const [
          'pdf',
          'doc',
          'docx',
          'txt',
          'md',
          'csv',
          'html',
          'htm',
          'xml',
          'json',
          'xls',
          'xlsx',
          'ppt',
          'pptx',
          'odt',
          'ods',
          'odp',
          'rtf',
          'sql',
          'js',
          'css',
          'jpg',
          'jpeg',
          'png',
          'webp',
        ],
      );

      if (resultado == null || resultado.files.isEmpty) {
        return;
      }

      final arquivos = resultado.files.take(disponiveis);
      final novosAnexos = <_AnexoSelecionado>[];

      for (final arquivo in arquivos) {
        Uint8List? bytes = arquivo.bytes;

        // No mobile algumas versões/plataformas podem não retornar bytes
        // mesmo com withData. Nesse caso usamos o XFile do caminho retornado.
        if (bytes == null && arquivo.path != null) {
          bytes = await XFile(arquivo.path!).readAsBytes();
        }

        if (bytes == null || bytes.isEmpty) {
          if (mounted) {
            _mostrarSnack(
              'Não foi possível ler "${arquivo.name}".',
            );
          }
          continue;
        }

        if (bytes.length > _maxArquivoBytes) {
          if (mounted) {
            _mostrarSnack(
              'O arquivo "${arquivo.name}" ultrapassa 18 MB e não foi adicionado.',
            );
          }
          continue;
        }

        final mimeType = _mimeTypePorNome(arquivo.name);

        if (mimeType == null) {
          if (mounted) {
            _mostrarSnack(
              'O tipo do arquivo "${arquivo.name}" não é suportado.',
            );
          }
          continue;
        }

        novosAnexos.add(
          _AnexoSelecionado(
            nome: arquivo.name,
            mimeType: mimeType,
            bytes: bytes,
          ),
        );
      }

      if (!mounted) return;

      setState(() {
        _anexos.addAll(novosAnexos);
      });

      if (resultado.files.length > disponiveis) {
        _mostrarSnack(
          'O limite é de $_maxArquivos arquivos por mensagem.',
        );
      }
    } catch (erro) {
      debugPrint('[Jisa IA] Erro ao selecionar arquivo: $erro');

      if (!mounted) return;

      _mostrarSnack(
        'Não foi possível selecionar o arquivo.',
      );
    }
  }

  void _removerAnexo(int index) {
    if (_enviando) return;

    if (index < 0 || index >= _anexos.length) return;

    setState(() {
      _anexos.removeAt(index);
    });
  }

  bool _validarTamanhoArquivo(int tamanho, String nome) {
    if (tamanho <= 0) {
      _mostrarSnack('O arquivo "$nome" está vazio.');
      return false;
    }

    if (tamanho > _maxArquivoBytes) {
      _mostrarSnack(
        'O arquivo "$nome" ultrapassa o limite de 18 MB.',
      );
      return false;
    }

    return true;
  }

  // ============================================================
  // ENVIO
  // ============================================================

  Future<void> _enviarMensagem() async {
    if (_enviando) return;

    final mensagem = _mensagemController.text.trim();

    if (mensagem.isEmpty && _anexos.isEmpty) {
      return;
    }

    final anexosEnvio =
        _anexos.map((anexo) => anexo.copiar()).toList(growable: false);

    final gerarImagem = _deveGerarImagem(
      mensagem,
      anexosEnvio,
    );

    _ultimaRequisicao = _RequisicaoAnterior(
      mensagem: mensagem,
      anexos: anexosEnvio,
      gerarImagem: gerarImagem,
    );

    setState(() {
      _mensagens.add(
        _MensagemChat(
          texto:
              mensagem.isEmpty ? _textoPadraoParaAnexos(anexosEnvio) : mensagem,
          autor: _AutorMensagem.usuario,
          anexos: anexosEnvio,
        ),
      );

      _enviando = true;
      _anexos.clear();
    });

    _mensagemController.clear();
    _campoFocus.unfocus();
    _rolarParaFinal();

    if (gerarImagem) {
      await _gerarImagem(
        mensagem: mensagem,
        anexos: anexosEnvio,
      );
    } else {
      await _consultarIa(
        mensagem: mensagem,
        anexos: anexosEnvio,
      );
    }
  }

  bool _deveGerarImagem(
    String mensagem,
    List<_AnexoSelecionado> anexos,
  ) {
    final texto = _normalizarTexto(mensagem).trim();

    if (texto.isEmpty) return false;

    // O endpoint de imagem aceita somente imagens como referência.
    // Se houver documento junto, tratamos como pergunta/análise.
    if (!anexos.every((anexo) => anexo.ehImagem)) {
      return false;
    }

    const comandosDiretos = [
      'gere uma imagem',
      'gere a imagem',
      'gerar uma imagem',
      'gerar a imagem',
      'crie uma imagem',
      'crie a imagem',
      'criar uma imagem',
      'criar a imagem',
      'faça uma imagem',
      'faca uma imagem',
      'faça a imagem',
      'faca a imagem',
      'quero uma imagem',
      'quero a imagem',
      'mostre uma imagem',
      'mostre a imagem',
      'desenhe',
      'gere uma fachada',
      'crie uma fachada',
      'gere um projeto visual',
      'crie um projeto visual',
      'gere uma ilustracao',
      'crie uma ilustracao',
      'transforme esta imagem',
      'transforme essa imagem',
      'edite esta imagem',
      'edite essa imagem',
      'mude esta imagem',
      'mude essa imagem',
      'como ficaria',
      'mostre como ficaria',
      'visualize como ficaria',
      'faça de verdade',
      'faca de verdade',
      'faça ela de verdade',
      'faca ela de verdade',
      'mais realista',
      'deixe mais realista',
      'quero realista',
      'quero ela realista',
      'refaça a imagem',
      'refaca a imagem',
      'faça novamente',
      'faca novamente',
    ];

    if (comandosDiretos.any(texto.contains)) {
      return true;
    }

    // Também reconhece pedidos contextuais curtos, por exemplo:
    // "gere ela", "faça isso", "crie agora".
    final temVerboVisual = RegExp(
      r'\b(gere|gerar|crie|criar|faca|faça|desenhe|mostre|visualize)\b',
    ).hasMatch(texto);

    final temReferenciaContextual = RegExp(
      r'\b(ela|ele|isso|isto|essa|esta|esse|este|dela|dele|agora|assim)\b',
    ).hasMatch(texto);

    return temVerboVisual && temReferenciaContextual;
  }

  String _resolverPromptImagem(String mensagem) {
    final atual = mensagem.trim();
    if (atual.isEmpty) return atual;

    final contexto = <String>[];
    for (var i = _mensagens.length - 1; i >= 0 && contexto.length < 12; i--) {
      final item = _mensagens[i];
      if (item.autor == _AutorMensagem.erro) continue;
      final texto = item.texto.trim();
      if (texto.isEmpty) continue;
      if (texto == atual && item.autor == _AutorMensagem.usuario) continue;
      if (texto.startsWith('Olá! Eu sou a Jisa')) continue;
      final papel = item.autor == _AutorMensagem.usuario ? 'Usuário' : 'Jisa';
      final imagem = item.imagemGerada != null ? ' [imagem gerada]' : '';
      contexto.insert(0, '$papel$imagem: $texto');
    }

    if (contexto.isEmpty) return atual;

    return '$atual\n\n'
        'CONTEXTO RECENTE DA CONVERSA:\n'
        '${contexto.join("\n\n")}\n\n'
        'Use o contexto acima para resolver referências como ela, essa casa, '
        'a anterior, como pedi, de verdade, mais realista e mude só. Preserve '
        'os requisitos já definidos, altere somente o que o usuário pediu agora '
        'e gere a imagem sem transformar uma correção simples em questionário.';
  }

  List<Map<String, dynamic>> _montarHistorico({int limite = 14}) {
    final itens = <Map<String, dynamic>>[];
    for (var i = _mensagens.length - 1; i >= 0 && itens.length < limite; i--) {
      final item = _mensagens[i];
      if (item.autor == _AutorMensagem.erro) continue;
      final texto = item.texto.trim();
      if (texto.isEmpty || texto.startsWith('Olá! Eu sou a Jisa')) continue;
      itens.insert(0, {
        'role': item.autor == _AutorMensagem.usuario ? 'user' : 'assistant',
        'content': texto,
        if (item.imagemGerada != null) 'teveImagemGerada': true,
      });
    }
    return itens;
  }

  Future<void> _consultarIa({
    required String mensagem,
    required List<_AnexoSelecionado> anexos,
  }) async {
    try {
      final respostaHttp = await http
          .post(
            Uri.parse(_endpointPerguntar),
            headers: const {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: jsonEncode({
              'mensagem': mensagem,
              'historico': _montarHistorico(limite: 14),
              'preferenciasConversa': const {
                'executarAntesDePerguntar': true,
                'preservarContexto': true,
                'naoRepetirPerguntasRespondidas': true,
                'tratarCorrecaoComoContinuacao': true,
              },
              if (anexos.isNotEmpty)
                'arquivos': anexos.map((anexo) => anexo.paraJson()).toList(),
            }),
          )
          .timeout(
            const Duration(seconds: 90),
          );

      final dados = _decodificarResposta(respostaHttp);

      if (!mounted) return;

      if (respostaHttp.statusCode >= 200 && respostaHttp.statusCode < 300) {
        final respostaIa = dados?['resposta'];

        if (dados?['ok'] == true &&
            respostaIa is String &&
            respostaIa.trim().isNotEmpty) {
          setState(() {
            _mensagens.add(
              _MensagemChat(
                texto: respostaIa.trim(),
                autor: _AutorMensagem.ia,
              ),
            );

            _enviando = false;
          });

          _rolarParaFinal();
          return;
        }

        _adicionarErro(
          'A Jisa respondeu, mas não foi possível interpretar a resposta.',
        );
        return;
      }

      _tratarErroHttp(respostaHttp.statusCode, dados);
    } on TimeoutException {
      if (!mounted) return;

      _adicionarErro(
        'A resposta está demorando mais que o esperado. '
        'Verifique sua conexão e tente novamente.',
      );
    } on http.ClientException {
      if (!mounted) return;

      _adicionarErro(
        'Não foi possível conectar ao serviço do Ache Obra. '
        'Verifique sua conexão com a internet.',
      );
    } catch (erro) {
      if (!mounted) return;

      debugPrint(
        '[Jisa IA] Erro inesperado ao consultar IA: $erro',
      );

      _adicionarErro(
        'Ocorreu um problema ao consultar a Jisa. Tente novamente.',
      );
    }
  }

  Future<void> _gerarImagem({
    required String mensagem,
    required List<_AnexoSelecionado> anexos,
  }) async {
    try {
      final prompt = _resolverPromptImagem(mensagem);

      if (prompt.isEmpty) {
        _adicionarErro(
          'Descreva a imagem que você deseja que a Jisa crie.',
        );
        return;
      }

      final respostaHttp = await http
          .post(
            Uri.parse(_endpointGerarImagem),
            headers: const {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: jsonEncode({
              'prompt': prompt,
              'mensagemAtual': mensagem,
              'historico': _montarHistorico(limite: 14),
              'preferenciasConversa': const {
                'executarAntesDePerguntar': true,
                'preservarContexto': true,
                'tratarCorrecaoComoContinuacao': true,
                'manterRequisitosAnteriores': true,
              },
              'aspectRatio': '1:1',
              'imageSize': '1K',
              if (anexos.isNotEmpty)
                'arquivos': anexos
                    .where((anexo) => anexo.ehImagem)
                    .map((anexo) => anexo.paraJson())
                    .toList(),
            }),
          )
          .timeout(
            const Duration(seconds: 120),
          );

      final dados = _decodificarResposta(respostaHttp);

      if (!mounted) return;

      if (respostaHttp.statusCode >= 200 &&
          respostaHttp.statusCode < 300 &&
          dados?['ok'] == true) {
        final imagemBase64 = dados?['imagemBase64'];
        final mimeType = dados?['mimeType'];
        final respostaTexto = dados?['resposta'];

        if (imagemBase64 is String && imagemBase64.trim().isNotEmpty) {
          Uint8List bytes;

          try {
            bytes = base64Decode(imagemBase64);
          } catch (_) {
            _adicionarErro(
              'A Jisa gerou a imagem, mas o aplicativo não conseguiu exibi-la.',
            );
            return;
          }

          setState(() {
            _mensagens.add(
              _MensagemChat(
                texto:
                    respostaTexto is String && respostaTexto.trim().isNotEmpty
                        ? respostaTexto.trim()
                        : 'Imagem criada pela Jisa.',
                autor: _AutorMensagem.ia,
                imagemGerada: bytes,
                imagemGeradaMimeType:
                    mimeType is String ? mimeType : 'image/png',
              ),
            );

            _enviando = false;
          });

          _rolarParaFinal();
          return;
        }

        _adicionarErro(
          'A Jisa respondeu, mas a imagem gerada não foi recebida corretamente.',
        );
        return;
      }

      _tratarErroHttp(respostaHttp.statusCode, dados);
    } on TimeoutException {
      if (!mounted) return;

      _adicionarErro(
        'A geração da imagem está demorando mais que o esperado. '
        'Tente novamente em alguns instantes.',
      );
    } on http.ClientException {
      if (!mounted) return;

      _adicionarErro(
        'Não foi possível conectar ao serviço de geração de imagens.',
      );
    } catch (erro) {
      if (!mounted) return;

      debugPrint(
        '[Jisa IA] Erro inesperado ao gerar imagem: $erro',
      );

      _adicionarErro(
        'Ocorreu um problema ao gerar a imagem. Tente novamente.',
      );
    }
  }

  Map<String, dynamic>? _decodificarResposta(
    http.Response resposta,
  ) {
    try {
      final json = jsonDecode(
        utf8.decode(resposta.bodyBytes),
      );

      if (json is Map<String, dynamic>) {
        return json;
      }
    } catch (_) {
      // A mensagem amigável será exibida pelo tratamento HTTP.
    }

    return null;
  }

  void _tratarErroHttp(
    int statusCode,
    Map<String, dynamic>? dados,
  ) {
    final erroBackend = dados?['erro']?.toString();

    if (statusCode == 400) {
      _adicionarErro(
        erroBackend ?? 'A solicitação enviada para a Jisa não é válida.',
      );
      return;
    }

    if (statusCode == 413) {
      _adicionarErro(
        'O arquivo enviado é grande demais para ser processado.',
      );
      return;
    }

    if (statusCode == 429) {
      _adicionarErro(
        erroBackend ??
            'A Jisa está recebendo muitas solicitações neste momento. '
                'Aguarde alguns instantes e tente novamente.',
      );
      return;
    }

    if (statusCode == 503) {
      _adicionarErro(
        erroBackend ??
            'A Jisa está temporariamente indisponível. '
                'Tente novamente em alguns instantes.',
      );
      return;
    }

    if (statusCode >= 500) {
      _adicionarErro(
        erroBackend ??
            'Não foi possível acessar a Jisa neste momento. '
                'Tente novamente.',
      );
      return;
    }

    _adicionarErro(
      erroBackend ?? 'Não foi possível concluir sua solicitação.',
    );
  }

  // ============================================================
  // TENTAR NOVAMENTE
  // ============================================================

  Future<void> _tentarNovamente() async {
    if (_enviando) return;

    final requisicao = _ultimaRequisicao;

    if (requisicao == null) return;

    setState(() {
      if (_mensagens.isNotEmpty &&
          _mensagens.last.autor == _AutorMensagem.erro) {
        _mensagens.removeLast();
      }

      _enviando = true;
    });

    _rolarParaFinal();

    if (requisicao.gerarImagem) {
      await _gerarImagem(
        mensagem: requisicao.mensagem,
        anexos: requisicao.anexos,
      );
    } else {
      await _consultarIa(
        mensagem: requisicao.mensagem,
        anexos: requisicao.anexos,
      );
    }
  }

  // ============================================================
  // UTILITÁRIOS
  // ============================================================

  void _adicionarErro(String mensagem) {
    if (!mounted) return;

    setState(() {
      _mensagens.add(
        _MensagemChat(
          texto: mensagem,
          autor: _AutorMensagem.erro,
          permitirNovaTentativa: true,
        ),
      );

      _enviando = false;
    });

    _rolarParaFinal();
  }

  void _mostrarSnack(String mensagem) {
    if (!mounted) return;

    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(mensagem),
        ),
      );
  }

  void _rolarParaFinal() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;

      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    });
  }

  String _textoPadraoParaAnexos(
    List<_AnexoSelecionado> anexos,
  ) {
    if (anexos.length == 1) {
      return anexos.first.ehImagem
          ? 'Analise esta imagem.'
          : 'Analise este arquivo.';
    }

    return 'Analise estes ${anexos.length} arquivos.';
  }

  String _normalizarTexto(String valor) {
    return valor
        .toLowerCase()
        .replaceAll('á', 'a')
        .replaceAll('à', 'a')
        .replaceAll('ã', 'a')
        .replaceAll('â', 'a')
        .replaceAll('é', 'e')
        .replaceAll('ê', 'e')
        .replaceAll('í', 'i')
        .replaceAll('ó', 'o')
        .replaceAll('ô', 'o')
        .replaceAll('õ', 'o')
        .replaceAll('ú', 'u')
        .replaceAll('ç', 'c');
  }

  String _mimeImagemPorNome(
    String nome, {
    String? fallback,
  }) {
    final mime = _mimeTypePorNome(nome);

    if (mime != null && mime.startsWith('image/')) {
      return mime;
    }

    if (fallback != null && fallback.toLowerCase().startsWith('image/')) {
      final normalizado = fallback.toLowerCase();

      if (normalizado == 'image/jpg') {
        return 'image/jpeg';
      }

      return normalizado;
    }

    return 'image/jpeg';
  }

  String? _mimeTypePorNome(String nome) {
    final extensao = nome.split('.').last.toLowerCase().trim();

    const tipos = <String, String>{
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'webp': 'image/webp',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'csv': 'text/csv',
      'html': 'text/html',
      'htm': 'text/html',
      'xml': 'text/xml',
      'json': 'application/json',
      'doc': 'application/msword',
      'docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'odt': 'application/vnd.oasis.opendocument.text',
      'ods': 'application/vnd.oasis.opendocument.spreadsheet',
      'odp': 'application/vnd.oasis.opendocument.presentation',
      'rtf': 'application/rtf',
      'sql': 'application/sql',
      'js': 'application/javascript',
      'css': 'text/css',
    };

    return tipos[extensao];
  }

  // ============================================================
  // BUILD
  // ============================================================

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F6F8),
      appBar: AppBar(
        backgroundColor: _azulAcheObra,
        foregroundColor: Colors.white,
        elevation: 0,
        titleSpacing: 0,
        title: const Row(
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor: _laranjaAcheObra,
              child: Icon(
                Icons.auto_awesome,
                color: Colors.white,
                size: 20,
              ),
            ),
            SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Jisa IA',
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                Text(
                  'Assistente de construção',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.normal,
                    color: Colors.white70,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.fromLTRB(
                  14,
                  18,
                  14,
                  18,
                ),
                itemCount: _mensagens.length + (_enviando ? 1 : 0),
                itemBuilder: (context, index) {
                  if (_enviando && index == _mensagens.length) {
                    return const _IndicadorPensando();
                  }

                  final mensagem = _mensagens[index];

                  return _BalaoMensagem(
                    mensagem: mensagem,
                    onTentarNovamente: mensagem.permitirNovaTentativa
                        ? _tentarNovamente
                        : null,
                  );
                },
              ),
            ),
            if (_anexos.isNotEmpty)
              _BarraAnexos(
                anexos: _anexos,
                bloqueado: _enviando,
                onRemover: _removerAnexo,
              ),
            _buildCampoMensagem(),
          ],
        ),
      ),
    );
  }

  Widget _buildCampoMensagem() {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        10,
        9,
        10,
        11,
      ),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.06),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Material(
            color: const Color(0xFFF1F3F5),
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _enviando ? null : _abrirMenuAnexos,
              child: SizedBox(
                width: 46,
                height: 46,
                child: Icon(
                  Icons.add_rounded,
                  color: _enviando ? Colors.grey : _azulAcheObra,
                  size: 28,
                ),
              ),
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: TextField(
              controller: _mensagemController,
              focusNode: _campoFocus,
              enabled: !_enviando,
              minLines: 1,
              maxLines: 5,
              textCapitalization: TextCapitalization.sentences,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(
                hintText: _enviando
                    ? 'Aguarde a Jisa...'
                    : _anexos.isEmpty
                        ? 'Pergunte à Jisa...'
                        : 'Pergunte sobre o anexo...',
                filled: true,
                fillColor: const Color(0xFFF1F3F5),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),
          const SizedBox(width: 7),
          Material(
            color: _enviando ? Colors.grey.shade400 : _laranjaAcheObra,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _enviando ? null : _enviarMensagem,
              child: const SizedBox(
                width: 48,
                height: 48,
                child: Icon(
                  Icons.send_rounded,
                  color: Colors.white,
                  size: 22,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _formatarMarkdownBasico(String valor) {
  var texto = valor.replaceAll('\r\n', '\n');

  // O SelectableText não interpreta Markdown; limpamos as marcações mais
  // comuns para não mostrar **, *, # e semelhantes ao usuário.
  texto = texto
      .replaceAll(RegExp(r'\*\*(.*?)\*\*'), r'$1')
      .replaceAll(RegExp(r'__(.*?)__'), r'$1')
      .replaceAllMapped(RegExp(r'(^|[^*])\*([^*\n]+)\*([^*]|$)'),
          (m) => '${m.group(1) ?? ''}${m.group(2) ?? ''}${m.group(3) ?? ''}')
      .replaceAllMapped(RegExp(r'(^|[^_])_([^_\n]+)_([^_]|$)'),
          (m) => '${m.group(1) ?? ''}${m.group(2) ?? ''}${m.group(3) ?? ''}');

  texto = texto.replaceAllMapped(
    RegExp(r'^\s*[\*\-]\s+', multiLine: true),
    (_) => '• ',
  );

  texto = texto.replaceAllMapped(
    RegExp(r'^\s{0,3}#{1,6}\s+', multiLine: true),
    (_) => '',
  );

  texto = texto.replaceAll(RegExp(r'\n{3,}'), '\n\n');

  return texto.trim();
}

// ============================================================
// MODELOS
// ============================================================

enum _AutorMensagem {
  usuario,
  ia,
  erro,
}

class _AnexoSelecionado {
  final String nome;
  final String mimeType;
  final Uint8List bytes;

  const _AnexoSelecionado({
    required this.nome,
    required this.mimeType,
    required this.bytes,
  });

  bool get ehImagem => mimeType.startsWith('image/');

  Map<String, dynamic> paraJson() {
    return {
      'nome': nome,
      'mimeType': mimeType,
      'base64': base64Encode(bytes),
    };
  }

  _AnexoSelecionado copiar() {
    return _AnexoSelecionado(
      nome: nome,
      mimeType: mimeType,
      bytes: Uint8List.fromList(bytes),
    );
  }
}

class _RequisicaoAnterior {
  final String mensagem;
  final List<_AnexoSelecionado> anexos;
  final bool gerarImagem;

  const _RequisicaoAnterior({
    required this.mensagem,
    required this.anexos,
    required this.gerarImagem,
  });
}

class _MensagemChat {
  final String texto;
  final _AutorMensagem autor;
  final bool permitirNovaTentativa;
  final List<_AnexoSelecionado> anexos;
  final Uint8List? imagemGerada;
  final String? imagemGeradaMimeType;

  const _MensagemChat({
    required this.texto,
    required this.autor,
    this.permitirNovaTentativa = false,
    this.anexos = const [],
    this.imagemGerada,
    this.imagemGeradaMimeType,
  });
}

// ============================================================
// BARRA DE ANEXOS SELECIONADOS
// ============================================================

class _BarraAnexos extends StatelessWidget {
  final List<_AnexoSelecionado> anexos;
  final bool bloqueado;
  final ValueChanged<int> onRemover;

  const _BarraAnexos({
    required this.anexos,
    required this.bloqueado,
    required this.onRemover,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
      child: SizedBox(
        height: 82,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: anexos.length,
          separatorBuilder: (_, __) => const SizedBox(width: 8),
          itemBuilder: (context, index) {
            final anexo = anexos[index];

            return Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  width: anexo.ehImagem ? 76 : 150,
                  height: 74,
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F3F5),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: const Color(0xFFE0E4E8),
                    ),
                  ),
                  child: anexo.ehImagem
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(11),
                          child: Image.memory(
                            anexo.bytes,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => const Center(
                              child: Icon(
                                Icons.image_outlined,
                              ),
                            ),
                          ),
                        )
                      : Padding(
                          padding: const EdgeInsets.all(10),
                          child: Row(
                            children: [
                              Icon(
                                _iconeArquivo(
                                  anexo.mimeType,
                                ),
                                color: const Color(0xFF1A2C42),
                              ),
                              const SizedBox(width: 7),
                              Expanded(
                                child: Text(
                                  anexo.nome,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                ),
                Positioned(
                  right: -5,
                  top: -5,
                  child: Material(
                    color: const Color(0xFF1A2C42),
                    shape: const CircleBorder(),
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: bloqueado ? null : () => onRemover(index),
                      child: const SizedBox(
                        width: 23,
                        height: 23,
                        child: Icon(
                          Icons.close,
                          color: Colors.white,
                          size: 15,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static IconData _iconeArquivo(String mimeType) {
    if (mimeType == 'application/pdf') {
      return Icons.picture_as_pdf_outlined;
    }

    if (mimeType.contains('word') || mimeType.contains('document')) {
      return Icons.description_outlined;
    }

    if (mimeType.contains('excel') ||
        mimeType.contains('spreadsheet') ||
        mimeType == 'text/csv') {
      return Icons.table_chart_outlined;
    }

    if (mimeType.contains('powerpoint') || mimeType.contains('presentation')) {
      return Icons.slideshow_outlined;
    }

    return Icons.insert_drive_file_outlined;
  }
}

// ============================================================
// BALÃO DA MENSAGEM
// ============================================================

class _BalaoMensagem extends StatelessWidget {
  final _MensagemChat mensagem;
  final VoidCallback? onTentarNovamente;

  const _BalaoMensagem({
    required this.mensagem,
    this.onTentarNovamente,
  });

  @override
  Widget build(BuildContext context) {
    final usuario = mensagem.autor == _AutorMensagem.usuario;

    final erro = mensagem.autor == _AutorMensagem.erro;

    Color backgroundColor;
    Color textColor;

    if (usuario) {
      backgroundColor = const Color(0xFF1A2C42);
      textColor = Colors.white;
    } else if (erro) {
      backgroundColor = const Color(0xFFFFF3E0);
      textColor = const Color(0xFF7A4100);
    } else {
      backgroundColor = Colors.white;
      textColor = const Color(0xFF202124);
    }

    return Align(
      alignment: usuario ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.86,
        ),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(
          horizontal: 15,
          vertical: 12,
        ),
        decoration: BoxDecoration(
          color: backgroundColor,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(usuario ? 18 : 4),
            bottomRight: Radius.circular(usuario ? 4 : 18),
          ),
          border: usuario
              ? null
              : Border.all(
                  color:
                      erro ? const Color(0xFFFFCC80) : const Color(0xFFE4E7EB),
                ),
          boxShadow: usuario
              ? null
              : [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.035),
                    blurRadius: 5,
                    offset: const Offset(0, 2),
                  ),
                ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!usuario)
              Padding(
                padding: const EdgeInsets.only(bottom: 7),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      erro ? Icons.error_outline : Icons.auto_awesome,
                      size: 15,
                      color: erro
                          ? const Color(0xFFE67E00)
                          : const Color(0xFFFF8C00),
                    ),
                    const SizedBox(width: 5),
                    Text(
                      erro ? 'Ache Obra' : 'Jisa IA',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: erro
                            ? const Color(0xFFE67E00)
                            : const Color(0xFFFF8C00),
                      ),
                    ),
                  ],
                ),
              ),
            if (mensagem.anexos.isNotEmpty) ...[
              _AnexosNoBalao(
                anexos: mensagem.anexos,
                usuario: usuario,
              ),
              const SizedBox(height: 9),
            ],
            if (mensagem.imagemGerada != null) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Image.memory(
                  mensagem.imagemGerada!,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  errorBuilder: (_, __, ___) {
                    return Container(
                      height: 180,
                      alignment: Alignment.center,
                      color: const Color(0xFFF1F3F5),
                      child: const Text(
                        'Não foi possível exibir a imagem.',
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 10),
            ],
            if (mensagem.texto.trim().isNotEmpty)
              SelectableText(
                usuario
                    ? mensagem.texto
                    : _formatarMarkdownBasico(mensagem.texto),
                style: TextStyle(
                  fontSize: 15,
                  height: 1.4,
                  color: textColor,
                ),
              ),
            if (erro &&
                mensagem.permitirNovaTentativa &&
                onTentarNovamente != null) ...[
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: onTentarNovamente,
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  foregroundColor: const Color(0xFFE67E00),
                ),
                icon: const Icon(
                  Icons.refresh,
                  size: 18,
                ),
                label: const Text(
                  'Tentar novamente',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _AnexosNoBalao extends StatelessWidget {
  final List<_AnexoSelecionado> anexos;
  final bool usuario;

  const _AnexosNoBalao({
    required this.anexos,
    required this.usuario,
  });

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 7,
      runSpacing: 7,
      children: anexos.map((anexo) {
        if (anexo.ehImagem) {
          return ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.memory(
              anexo.bytes,
              width: 190,
              height: 150,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) {
                return const SizedBox(
                  width: 90,
                  height: 70,
                  child: Center(
                    child: Icon(
                      Icons.image_not_supported_outlined,
                    ),
                  ),
                );
              },
            ),
          );
        }

        return Container(
          constraints: const BoxConstraints(maxWidth: 220),
          padding: const EdgeInsets.symmetric(
            horizontal: 10,
            vertical: 8,
          ),
          decoration: BoxDecoration(
            color: usuario
                ? Colors.white.withOpacity(0.12)
                : const Color(0xFFF1F3F5),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                _BarraAnexos._iconeArquivo(
                  anexo.mimeType,
                ),
                size: 20,
                color: usuario ? Colors.white : const Color(0xFF1A2C42),
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  anexo.nome,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: usuario ? Colors.white : const Color(0xFF202124),
                  ),
                ),
              ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

// ============================================================
// INDICADOR "PENSANDO"
// ============================================================

class _IndicadorPensando extends StatefulWidget {
  const _IndicadorPensando();

  @override
  State<_IndicadorPensando> createState() => _IndicadorPensandoState();
}

class _IndicadorPensandoState extends State<_IndicadorPensando> {
  Timer? _timer;
  int _pontos = 1;

  @override
  void initState() {
    super.initState();

    _timer = Timer.periodic(
      const Duration(milliseconds: 450),
      (_) {
        if (!mounted) return;

        setState(() {
          _pontos++;

          if (_pontos > 3) {
            _pontos = 1;
          }
        });
      },
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(
          horizontal: 15,
          vertical: 12,
        ),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(18),
            topRight: Radius.circular(18),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(18),
          ),
          border: Border.all(
            color: const Color(0xFFE4E7EB),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Color(0xFFFF8C00),
              ),
            ),
            const SizedBox(width: 10),
            Text(
              'Pensando${'.' * _pontos}',
              style: const TextStyle(
                color: Color(0xFF6B7280),
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
